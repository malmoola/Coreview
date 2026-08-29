//! IPC for the credential vault.
//!
//! **Exactly one command returns a secret**, and it is `reveal_credential`.
//! Everything else takes credentials in and hands back references.
//!
//! That one exception is deliberate and was asked for: an administrator has to
//! be able to check what is stored, and a vault you cannot read from is a
//! vault people work around by keeping a spreadsheet. The cost is real and
//! worth stating — once a secret can cross to the interface, "not visible from
//! the GUI" is a rendering promise rather than an architectural one, and a
//! rendering promise does not survive a devtools window.
//!
//! What survives is the narrower guarantee, and a test enforces it: no *other*
//! command may return a secret. Listing, saving, status and deletion cannot
//! leak one by accident; revealing is a single, named, deliberate act that
//! requires the vault to be unlocked first.
//!
//! The unlocked key lives in memory for the length of the app session and is
//! zeroed when it is dropped. It is never written anywhere.

use coreview_discover::snmp::{AuthKind, PrivKind, SnmpAuth};
use coreview_discover::ssh::{Credentials, Secret};
use coreview_discover::vault::{self, SealedSecret, VaultHeader, VaultKey};
use serde::Deserialize;
use tauri::State;

use crate::commands::AppState;
use crate::db;

type CmdResult<T> = Result<T, String>;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What the interface is allowed to know about the vault.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub credentials: usize,
    pub minimum_passphrase: usize,
}

/// A saved credential as the interface sees it: everything except the secrets.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub label: String,
    /// "ssh" or "snmp".
    pub kind: String,
    pub username: String,
    /// Algorithm words for SNMPv3. Not secret, and needed to show what a
    /// credential is configured for.
    pub detail: String,
    /// Whether a second secret is stored — an enable password, or an SNMPv3
    /// privacy password. Whether one exists is not itself a secret, and the
    /// interface needs it to render honestly.
    pub has_second_secret: bool,
}

#[tauri::command]
pub fn vault_status(state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    let conn = state.db.lock().map_err(db_err)?;
    let exists = db::vault_header(&conn).map_err(db_err)?.is_some();
    let credentials = db::list_credentials(&conn).map_err(db_err)?.len();
    let unlocked = state.vault_key.lock().map_err(db_err)?.is_some();
    Ok(VaultStatus {
        exists,
        unlocked,
        credentials,
        minimum_passphrase: vault::MIN_PASSPHRASE,
    })
}

/// Creates the vault and leaves it unlocked for this session.
#[tauri::command]
pub fn create_vault(state: State<'_, AppState>, passphrase: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    if db::vault_header(&conn).map_err(db_err)?.is_some() {
        return Err("A vault already exists. Unlock it, or discard it and start again.".into());
    }
    let (header, key) = vault::create(&passphrase).map_err(|e| e.to_string())?;
    db::create_vault(&conn, &header.salt, &header.verifier, now_ms()).map_err(db_err)?;
    *state.vault_key.lock().map_err(db_err)? = Some(key);
    Ok(())
}

#[tauri::command]
pub fn unlock_vault(state: State<'_, AppState>, passphrase: String) -> CmdResult<()> {
    let header = {
        let conn = state.db.lock().map_err(db_err)?;
        db::vault_header(&conn)
            .map_err(db_err)?
            .ok_or("There is no vault yet. Create one before unlocking it.")?
    };
    let key = vault::unlock(
        &passphrase,
        &VaultHeader {
            salt: header.0,
            verifier: header.1,
        },
    )
    .map_err(|e| e.to_string())?;
    *state.vault_key.lock().map_err(db_err)? = Some(key);
    Ok(())
}

/// Locks the vault, dropping the key.
#[tauri::command]
pub fn lock_vault(state: State<'_, AppState>) -> CmdResult<()> {
    // Dropping it zeroes it — VaultKey is ZeroizeOnDrop.
    *state.vault_key.lock().map_err(db_err)? = None;
    Ok(())
}

/// Discards the vault and everything in it.
///
/// The only way past a forgotten passphrase, and destructive by necessity:
/// without the key the stored rows are unreadable, so keeping them would be
/// keeping rubbish, and leaving them would make a new vault look like it had
/// contents. Returns how many credentials went, for the confirmation.
#[tauri::command]
pub fn discard_vault(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(db_err)?;
    let removed = db::destroy_vault(&conn).map_err(db_err)?;
    *state.vault_key.lock().map_err(db_err)? = None;
    Ok(removed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCredential {
    /// Absent for a new credential.
    pub id: Option<String>,
    pub label: String,
    /// "ssh" or "snmp".
    pub kind: String,
    pub username: String,
    pub secret: String,
    /// Enable password, or SNMPv3 privacy password.
    pub second_secret: Option<String>,
    /// SNMPv3 algorithm words, for example "sha|aes 256".
    pub detail: Option<String>,
}

#[tauri::command]
pub fn save_credential(state: State<'_, AppState>, credential: SaveCredential) -> CmdResult<String> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;

    let sealed = vault::seal(key, &credential.secret).map_err(|e| e.to_string())?;
    let extra = match credential.second_secret.filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => {
            let e = vault::seal(key, &s).map_err(|err| err.to_string())?;
            Some((e.nonce, e.ciphertext))
        }
    };

    let id = credential
        .id
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let stored = db::StoredCredential {
        id: id.clone(),
        label: credential.label,
        kind: credential.kind,
        username: credential.username,
        secret: (sealed.nonce, sealed.ciphertext),
        extra,
        detail: credential.detail.unwrap_or_default(),
    };

    let conn = state.db.lock().map_err(db_err)?;
    db::save_credential(&conn, &stored, now_ms()).map_err(db_err)?;
    Ok(id)
}

/// The saved credentials, without their secrets.
///
/// Works while locked, on purpose: knowing that a credential called "Core
/// switches" exists is not the same as knowing its password, and a list that
/// vanished when locked would make the vault unusable to reason about.
#[tauri::command]
pub fn list_credentials(state: State<'_, AppState>) -> CmdResult<Vec<CredentialSummary>> {
    let conn = state.db.lock().map_err(db_err)?;
    let rows = db::list_credentials(&conn).map_err(db_err)?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, label, kind, username, detail) in rows {
        // Only to report whether one exists — the value is not read.
        let has_second_secret = db::credential(&conn, &id)
            .map_err(db_err)?
            .map(|c| c.extra.is_some())
            .unwrap_or(false);
        out.push(CredentialSummary {
            id,
            label,
            kind,
            username,
            detail,
            has_second_secret,
        });
    }
    Ok(out)
}

/// What a stored credential actually contains.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevealedCredential {
    pub username: String,
    pub secret: String,
    pub second_secret: Option<String>,
}

/// Shows a stored credential in the clear.
///
/// The single command that returns a secret. It exists because an
/// administrator has to be able to verify what is saved — the alternative is
/// people keeping the real copy somewhere else.
///
/// Requires the vault to be unlocked, so revealing always costs the
/// passphrase at least once per session rather than being available to anyone
/// who reaches the running app.
#[tauri::command]
pub fn reveal_credential(
    state: State<'_, AppState>,
    id: String,
) -> CmdResult<RevealedCredential> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        db::credential(&conn, &id)
            .map_err(db_err)?
            .ok_or("That saved credential no longer exists.")?
    };
    Ok(RevealedCredential {
        username: stored.username,
        secret: open_secret(key, &stored.secret)?,
        second_secret: match &stored.extra {
            None => None,
            Some(e) => Some(open_secret(key, e)?),
        },
    })
}

#[tauri::command]
pub fn delete_credential(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::delete_credential(&conn, &id).map_err(db_err)?;
    Ok(())
}

/// The vault as a portable bundle, still encrypted.
///
/// Exists so credentials can move to another machine deliberately. What comes
/// out is ciphertext and the salt needed to derive the key again — importing it
/// requires the same passphrase, so this is not a way to read secrets, and the
/// vault does not even need to be unlocked to produce it.
///
/// It is still the most dangerous thing the app can write: it is every stored
/// credential in one file, and its safety rests entirely on the passphrase. The
/// interface defaults to leaving it out and says so plainly.
#[tauri::command]
pub fn export_vault(state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    let conn = state.db.lock().map_err(db_err)?;
    let (salt, verifier) = db::vault_header(&conn)
        .map_err(db_err)?
        .ok_or("There is no vault to export.")?;

    let mut items = Vec::new();
    for (id, ..) in db::list_credentials(&conn).map_err(db_err)? {
        if let Some(c) = db::credential(&conn, &id).map_err(db_err)? {
            items.push(serde_json::json!({
                "id": c.id,
                "label": c.label,
                "kind": c.kind,
                "username": c.username,
                "detail": c.detail,
                "secretNonce": c.secret.0,
                "secretCipher": c.secret.1,
                "extraNonce": c.extra.as_ref().map(|e| e.0.clone()),
                "extraCipher": c.extra.as_ref().map(|e| e.1.clone()),
            }));
        }
    }

    Ok(serde_json::json!({
        "vaultVersion": 1,
        "salt": salt,
        "verifier": verifier,
        "credentials": items,
    }))
}

/// Rebuilds SSH credentials from the vault, for use inside this process.
///
/// Deliberately not a command. It returns plaintext, so it is callable from
/// Rust and unreachable from the interface — the whole arrangement rests on
/// that distinction.
pub fn ssh_credentials(state: &AppState, id: &str) -> CmdResult<Credentials> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        db::credential(&conn, id)
            .map_err(db_err)?
            .ok_or("That saved credential no longer exists.")?
    };

    let password = open_secret(key, &stored.secret)?;
    let enable_password = match &stored.extra {
        None => None,
        Some(e) => Some(Secret::new(open_secret(key, e)?)),
    };
    Ok(Credentials {
        username: stored.username,
        password: Secret::new(password),
        enable_password,
    })
}

/// Rebuilds SNMP credentials from the vault. Also not a command, for the same
/// reason.
pub fn snmp_credentials(state: &AppState, id: &str) -> CmdResult<SnmpAuth> {
    let guard = state.vault_key.lock().map_err(db_err)?;
    let key = guard.as_ref().ok_or_else(|| vault::VaultError::Locked.to_string())?;
    let stored = {
        let conn = state.db.lock().map_err(db_err)?;
        db::credential(&conn, id)
            .map_err(db_err)?
            .ok_or("That saved credential no longer exists.")?
    };

    let secret = open_secret(key, &stored.secret)?;
    // "sha|aes 256" — algorithm words, which are not secret and so are stored
    // in clear beside the ciphertext.
    let (auth_word, priv_word) = stored.detail.split_once('|').unwrap_or(("sha", ""));

    if stored.username.is_empty() {
        return Ok(SnmpAuth::V2c { community: secret });
    }
    Ok(SnmpAuth::V3 {
        username: stored.username,
        auth_protocol: AuthKind::parse(auth_word).unwrap_or(AuthKind::Sha1),
        auth_password: secret,
        privacy: PrivKind::parse(priv_word),
        privacy_password: match &stored.extra {
            None => String::new(),
            Some(e) => open_secret(key, e)?,
        },
    })
}

fn open_secret(key: &VaultKey, parts: &(Vec<u8>, Vec<u8>)) -> CmdResult<String> {
    vault::open(
        key,
        &SealedSecret {
            nonce: parts.0.clone(),
            ciphertext: parts.1.clone(),
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    /// Only `reveal_credential` may return a secret, checked against the
    /// source rather than by inspection.
    ///
    /// Revealing is a deliberate act with a name that says so. A future edit
    /// that quietly returned plaintext from `list_credentials` or
    /// `vault_status` would look perfectly reasonable in review and would undo
    /// the arrangement without anybody noticing.
    #[test]
    fn only_the_reveal_command_returns_a_secret() {
        let source = include_str!("vault_commands.rs");
        let source = source.split("#[cfg(test)]").next().unwrap();
        let mut offenders = Vec::new();

        for block in source.split("#[tauri::command]").skip(1) {
            let signature: String = block.chars().take(400).collect();
            let name = signature
                .split("pub fn ")
                .nth(1)
                .and_then(|s| s.split('(').next())
                .unwrap_or("?")
                .to_string();
            if name == "reveal_credential" {
                continue;
            }

            // The return type, up to the opening brace.
            let returns = signature
                .split("->")
                .nth(1)
                .and_then(|s| s.split('{').next())
                .unwrap_or("")
                .to_string();

            for forbidden in [
                "Credentials",
                "SnmpAuth",
                "VaultKey",
                "SealedSecret",
                "StoredCredential",
                "RevealedCredential",
            ] {
                if returns.contains(forbidden) {
                    offenders.push(format!("{name} returns {forbidden}"));
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "a command other than reveal_credential returns something secret: {offenders:?}"
        );
    }

    #[test]
    fn revealing_is_a_single_named_command() {
        // If a second way to read a secret appears, it should be a deliberate
        // decision rather than something that accumulated.
        // Only the code above the test module — otherwise this test's own
        // text counts as a match and the check passes for the wrong reason.
        let source = include_str!("vault_commands.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        let revealers = code.matches("RevealedCredential> {").count();
        assert_eq!(revealers, 1, "there should be exactly one way to read a secret");
    }

    #[test]
    fn the_functions_that_do_return_secrets_are_not_commands() {
        // ssh_credentials and snmp_credentials exist and hand back plaintext;
        // the point is that they are plain Rust functions.
        let source = include_str!("vault_commands.rs");
        for name in ["fn ssh_credentials", "fn snmp_credentials"] {
            let at = source.find(name).expect("function missing");
            let before = &source[at.saturating_sub(200)..at];
            assert!(
                !before.contains("#[tauri::command]"),
                "{name} has become reachable from the interface"
            );
        }
    }
}
