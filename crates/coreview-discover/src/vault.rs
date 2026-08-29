//! Credentials kept encrypted at rest.
//!
//! Session credentials — typed for one run and gone when the app closes —
//! remain the default and need none of this. The vault is for the other case:
//! backing up ninety devices on a schedule you did not want to sit through, or
//! not retyping the same enable password forty times a day.
//!
//! Three properties this is built to hold, in order of how much they matter:
//!
//! **A stored secret never leaves Rust.** Not in an IPC response, not in a
//! log line, not in an error. The interface saves a credential and thereafter
//! refers to it by id; the plaintext exists only inside this process while it
//! is being used. That is what "not visible from the GUI" has to mean to be
//! worth anything — a hidden field is a rendering choice, and rendering
//! choices are one devtools window away from not applying.
//!
//! **The passphrase is not stored anywhere.** It derives a key and is
//! discarded. Forgetting it means re-entering the credentials, and there is no
//! recovery path, because a recovery path is a second way in.
//!
//! **A wrong passphrase fails rather than producing rubbish.** Authenticated
//! encryption gives that for free: a bad key does not decrypt to nonsense, it
//! refuses.

use argon2::Argon2;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Argon2id parameters.
///
/// 19 MiB and two passes is the OWASP minimum for interactive use. The cost is
/// paid once when the vault is unlocked, not per credential, so there is no
/// reason to go below it — and every reason not to, since the only thing
/// standing between a stolen database file and its contents is how expensive
/// each passphrase guess is.
const KDF_MEMORY_KIB: u32 = 19_456;
const KDF_PASSES: u32 = 2;
const KDF_LANES: u32 = 1;

const SALT_LEN: usize = 32;
const KEY_LEN: usize = 32;
/// XChaCha20 takes a 192-bit nonce, which is large enough to generate at
/// random without tracking what has been used.
const NONCE_LEN: usize = 24;

/// What a check phrase decrypts to. Its content does not matter; that it
/// decrypts at all is the whole test.
const VERIFIER_PLAINTEXT: &[u8] = b"coreview-vault-v1";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VaultError {
    // Sentence case with a full stop, against the usual Rust convention of
    // lowercase and no punctuation. Every one of these reaches a person
    // verbatim — the interface prints `to_string()` as its own line and never
    // composes it into a larger message — and "that passphrase does not
    // unlock this vault" sitting under a capitalised heading reads as a bug.
    #[error("That passphrase does not unlock this vault.")]
    WrongPassphrase,
    #[error("The vault is locked — unlock it before using a saved credential.")]
    Locked,
    #[error("A passphrase must be at least {0} characters.")]
    PassphraseTooShort(usize),
    #[error("The stored credential is damaged and cannot be read.")]
    Corrupt,
    #[error("Could not generate random bytes: {0}")]
    NoRandomness(String),
}

/// The shortest passphrase the vault will accept.
///
/// Not a strength meter. Argon2 makes guessing expensive, but nothing makes a
/// four-character passphrase survive an offline attack, and refusing one is
/// more honest than a green bar.
pub const MIN_PASSPHRASE: usize = 12;

/// An unlocked vault key. Zeroed when it goes out of scope.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct VaultKey([u8; KEY_LEN]);

impl std::fmt::Debug for VaultKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VaultKey(***)")
    }
}

/// What the database stores so a vault can be unlocked again.
///
/// Neither field is secret: the salt is public by design, and the verifier is
/// a ciphertext that reveals nothing without the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultHeader {
    pub salt: Vec<u8>,
    pub verifier: Vec<u8>,
}

/// One encrypted credential as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedSecret {
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

fn random(len: usize) -> Result<Vec<u8>, VaultError> {
    let mut bytes = vec![0u8; len];
    getrandom::getrandom(&mut bytes).map_err(|e| VaultError::NoRandomness(e.to_string()))?;
    Ok(bytes)
}

fn derive(passphrase: &str, salt: &[u8]) -> Result<VaultKey, VaultError> {
    let params = argon2::Params::new(KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES, Some(KEY_LEN))
        .map_err(|_| VaultError::Corrupt)?;
    let argon = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| VaultError::Corrupt)?;
    Ok(VaultKey(key))
}

fn cipher(key: &VaultKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.0.as_ref().into())
}

/// Creates a vault for the first time.
///
/// Returns the header to store and the key to hold for this session. The
/// passphrase is used and dropped; nothing derived from it beyond the key ever
/// leaves this function.
pub fn create(passphrase: &str) -> Result<(VaultHeader, VaultKey), VaultError> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(VaultError::PassphraseTooShort(MIN_PASSPHRASE));
    }
    let salt = random(SALT_LEN)?;
    let key = derive(passphrase, &salt)?;

    let nonce_bytes = random(NONCE_LEN)?;
    let sealed = cipher(&key)
        .encrypt(XNonce::from_slice(&nonce_bytes), VERIFIER_PLAINTEXT)
        .map_err(|_| VaultError::Corrupt)?;

    // Nonce and ciphertext travel together; splitting them across columns
    // would only create a way for them to get separated.
    let mut verifier = nonce_bytes;
    verifier.extend_from_slice(&sealed);

    Ok((VaultHeader { salt, verifier }, key))
}

/// Unlocks an existing vault, or says the passphrase is wrong.
///
/// The check is a decryption rather than a hash comparison, so there is no
/// stored value that a wrong passphrase could be compared against in variable
/// time, and no way for the check to pass while the key is still wrong.
pub fn unlock(passphrase: &str, header: &VaultHeader) -> Result<VaultKey, VaultError> {
    let key = derive(passphrase, &header.salt)?;
    if header.verifier.len() <= NONCE_LEN {
        return Err(VaultError::Corrupt);
    }
    let (nonce, sealed) = header.verifier.split_at(NONCE_LEN);
    let plain = cipher(&key)
        .decrypt(XNonce::from_slice(nonce), sealed)
        .map_err(|_| VaultError::WrongPassphrase)?;
    if plain != VERIFIER_PLAINTEXT {
        return Err(VaultError::WrongPassphrase);
    }
    Ok(key)
}

/// Encrypts a secret for storage.
///
/// A fresh nonce every time. Reusing one with the same key is the way to break
/// a stream cipher, and generating rather than counting means nothing has to
/// remember what was used.
pub fn seal(key: &VaultKey, secret: &str) -> Result<SealedSecret, VaultError> {
    let nonce = random(NONCE_LEN)?;
    let ciphertext = cipher(key)
        .encrypt(XNonce::from_slice(&nonce), secret.as_bytes())
        .map_err(|_| VaultError::Corrupt)?;
    Ok(SealedSecret { nonce, ciphertext })
}

/// Decrypts a stored secret.
///
/// Fails rather than returning something wrong: the ciphertext carries an
/// authentication tag, so a wrong key or a modified record is refused instead
/// of yielding a plausible-looking password.
pub fn open(key: &VaultKey, sealed: &SealedSecret) -> Result<String, VaultError> {
    if sealed.nonce.len() != NONCE_LEN {
        return Err(VaultError::Corrupt);
    }
    let plain = cipher(key)
        .decrypt(XNonce::from_slice(&sealed.nonce), sealed.ciphertext.as_ref())
        .map_err(|_| VaultError::WrongPassphrase)?;
    String::from_utf8(plain).map_err(|_| VaultError::Corrupt)
}

#[cfg(test)]
mod tests {

    /// Moving a credential between machines, which is what importing a project
    /// package with credentials does.
    ///
    /// The secrets in that file are sealed with the *exporting* vault's key, so
    /// the import has to unlock that header with its own passphrase, open each
    /// secret, and reseal it under the local key. Nothing on the importing
    /// machine may end up encrypted with someone else's passphrase.
    #[test]
    fn a_secret_moves_between_vaults_by_resealing() {
        let (exported_header, exporting) = create("passphrase on the first box").unwrap();
        let (_, importing) = create("a different passphrase here").unwrap();

        let from_them = seal(&exporting, "C!sco212").unwrap();
        // The local key must not be able to read the file as it arrived.
        assert!(open(&importing, &from_them).is_err());

        let source = unlock("passphrase on the first box", &exported_header).unwrap();
        let plain = open(&source, &from_them).unwrap();
        let ours = seal(&importing, &plain).unwrap();

        assert_eq!(open(&importing, &ours).unwrap(), "C!sco212");
        // Resealing produces different bytes, so the file's ciphertext is not
        // simply copied into the local database.
        assert_ne!(ours.ciphertext, from_them.ciphertext);
    }

    #[test]
    fn the_wrong_passphrase_will_not_open_an_exported_header() {
        let (header, _) = create("passphrase on the first box").unwrap();
        assert!(matches!(
            unlock("not that passphrase at all", &header),
            Err(VaultError::WrongPassphrase)
        ));
    }
    use super::*;

    const PASSPHRASE: &str = "a passphrase long enough";

    #[test]
    fn a_secret_survives_a_round_trip() {
        let (_, key) = create(PASSPHRASE).unwrap();
        let sealed = seal(&key, "C!sco212").unwrap();
        assert_eq!(open(&key, &sealed).unwrap(), "C!sco212");
    }

    #[test]
    fn the_stored_form_does_not_contain_the_secret() {
        // The point of the exercise. A database file that can be read is not
        // supposed to give anything up.
        let (header, key) = create(PASSPHRASE).unwrap();
        let sealed = seal(&key, "hunter2-the-password").unwrap();

        let bytes = [header.salt, header.verifier, sealed.nonce, sealed.ciphertext].concat();
        let haystack = String::from_utf8_lossy(&bytes);
        assert!(!haystack.contains("hunter2"), "the secret is in the stored form");
        assert!(!haystack.contains(PASSPHRASE), "the passphrase is in the stored form");
    }

    #[test]
    fn the_right_passphrase_unlocks_and_a_wrong_one_does_not() {
        let (header, key) = create(PASSPHRASE).unwrap();
        let sealed = seal(&key, "secret").unwrap();

        let reopened = unlock(PASSPHRASE, &header).unwrap();
        assert_eq!(open(&reopened, &sealed).unwrap(), "secret");

        // VaultKey has no PartialEq on purpose — comparing keys with == is a
        // timing-attack surface and the type should not invite it — so the
        // error side is unwrapped explicitly.
        assert_eq!(
            unlock("the wrong passphrase", &header).unwrap_err(),
            VaultError::WrongPassphrase
        );
        // Including one that differs by a single character.
        assert_eq!(
            unlock("a passphrase long enougH", &header).unwrap_err(),
            VaultError::WrongPassphrase
        );
    }

    #[test]
    fn a_wrong_key_refuses_rather_than_returning_rubbish() {
        // Authenticated encryption is what makes this true, and it matters:
        // a "password" that decrypted to garbage would be sent to a device.
        let (_, key_a) = create(PASSPHRASE).unwrap();
        let (_, key_b) = create("a different passphrase entirely").unwrap();
        let sealed = seal(&key_a, "secret").unwrap();
        assert_eq!(open(&key_b, &sealed), Err(VaultError::WrongPassphrase));
    }

    #[test]
    fn a_tampered_record_is_refused() {
        // Someone with write access to the database must not be able to swap a
        // stored password for one they know.
        let (_, key) = create(PASSPHRASE).unwrap();
        let mut sealed = seal(&key, "secret").unwrap();
        sealed.ciphertext[0] ^= 0xff;
        assert_eq!(open(&key, &sealed), Err(VaultError::WrongPassphrase));

        let mut moved_nonce = seal(&key, "secret").unwrap();
        moved_nonce.nonce[0] ^= 0xff;
        assert_eq!(open(&key, &moved_nonce), Err(VaultError::WrongPassphrase));
    }

    #[test]
    fn every_sealing_uses_a_fresh_nonce() {
        // Reusing a nonce with one key is how a stream cipher is broken, and
        // the same secret sealed twice must not produce the same bytes.
        let (_, key) = create(PASSPHRASE).unwrap();
        let a = seal(&key, "same secret").unwrap();
        let b = seal(&key, "same secret").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
        // And both still open.
        assert_eq!(open(&key, &a).unwrap(), "same secret");
        assert_eq!(open(&key, &b).unwrap(), "same secret");
    }

    #[test]
    fn two_vaults_with_one_passphrase_do_not_share_a_key() {
        // A per-vault salt is what stops one cracked passphrase unlocking
        // every Coreview installation that used it.
        let (header_a, key_a) = create(PASSPHRASE).unwrap();
        let (header_b, _) = create(PASSPHRASE).unwrap();
        assert_ne!(header_a.salt, header_b.salt);

        let sealed = seal(&key_a, "secret").unwrap();
        let key_b = unlock(PASSPHRASE, &header_b).unwrap();
        assert_eq!(open(&key_b, &sealed), Err(VaultError::WrongPassphrase));
    }

    #[test]
    fn a_short_passphrase_is_refused_at_creation() {
        // Argon2 makes guessing expensive; nothing makes a four-character
        // passphrase survive an offline attack.
        assert_eq!(
            create("short").map(|_| ()).unwrap_err(),
            VaultError::PassphraseTooShort(MIN_PASSPHRASE)
        );
        assert!(create(&"x".repeat(MIN_PASSPHRASE)).is_ok());
    }

    #[test]
    fn the_key_never_appears_in_debug_output() {
        let (_, key) = create(PASSPHRASE).unwrap();
        assert_eq!(format!("{key:?}"), "VaultKey(***)");
    }

    #[test]
    fn a_damaged_header_is_reported_as_damage_not_a_wrong_passphrase() {
        // Different problems, different fixes: one is retype it, the other is
        // the vault is gone.
        let (mut header, _) = create(PASSPHRASE).unwrap();
        header.verifier.truncate(4);
        assert_eq!(unlock(PASSPHRASE, &header).unwrap_err(), VaultError::Corrupt);
    }

    #[test]
    fn secrets_with_awkward_characters_survive() {
        // Real device passwords contain these.
        let (_, key) = create(PASSPHRASE).unwrap();
        for secret in ["C!sco212", "p@$$ w/ spaces", "unicode ✓ é", "", "\n\t"] {
            let sealed = seal(&key, secret).unwrap();
            assert_eq!(open(&key, &sealed).unwrap(), secret, "failed on {secret:?}");
        }
    }
}
