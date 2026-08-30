//! Talking to a device's command line over an interactive shell.
//!
//! Network gear does not give you a clean request/response channel. You get a
//! terminal: it echoes what you typed, it pages long output, it prints a login
//! banner, and it signals "I am ready" only by drawing its prompt again. Every
//! function here exists to turn that stream back into an answer.
//!
//! This is the part most worth testing offline, because it is where a naive
//! implementation quietly corrupts a configuration backup — a stray `--More--`
//! or an echoed command line in the middle of a saved config is not something
//! anyone notices until they try to restore it.

/// A device prompt, as it appears at the end of the output.
///
/// Cisco prompts end in `>` in user mode and `#` in enable mode. Detection is
/// on the last non-empty line, because a configuration can contain lines that
/// end in `#` — a comment, a banner — and only the last one is the prompt.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prompt {
    /// The whole prompt, for example `CORE-SW-01#`.
    pub text: String,
    /// The hostname in front of it, for example `CORE-SW-01`.
    pub hostname: String,
    /// `#` means enable mode; `>` means user mode and a config backup will
    /// fail until it is escalated.
    pub enabled: bool,
}

/// Finds the prompt at the end of a buffer, if the device has drawn one.
///
/// Returns `None` while output is still arriving, which is what the read loop
/// uses to decide whether to keep waiting.
pub fn find_prompt(buffer: &str) -> Option<Prompt> {
    let last = buffer.lines().rev().find(|l| !l.trim().is_empty())?;
    // The prompt is drawn without a newline after it, so anything trailing is
    // still being written. Trailing spaces are tolerated; trailing text is not.
    let line = last.trim_end();
    let (head, enabled) = match line.chars().last()? {
        '#' => (&line[..line.len() - 1], true),
        '>' => (&line[..line.len() - 1], false),
        _ => return None,
    };

    let hostname = head.trim();
    // Reject anything that cannot be a hostname. Without this, a config line
    // like `banner motd #` reads as a prompt and truncates the capture.
    if hostname.is_empty() || hostname.len() > 64 || hostname.contains(char::is_whitespace) {
        return None;
    }
    // A prompt in a sub-mode looks like `SW1(config-if)#`; the hostname is the
    // part before the bracket.
    let base = hostname.split('(').next().unwrap_or(hostname);
    if base.is_empty() || !base.chars().all(is_hostname_char) {
        return None;
    }

    Some(Prompt {
        text: line.to_string(),
        hostname: base.to_string(),
        enabled,
    })
}

fn is_hostname_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

/// Whether the device is waiting for a keypress before showing more output.
///
/// `terminal length 0` is sent first precisely so this does not happen, but it
/// fails on devices where the user has no privilege to set it, and on some
/// platforms it does not apply to every command.
pub fn is_paging(buffer: &str) -> bool {
    let tail = buffer.trim_end();
    let last = tail.lines().last().unwrap_or("").trim();
    last.contains("--More--") || last.contains("---- More ----") || last.ends_with("--more--")
}

/// Removes the paging markers a device left in captured output.
///
/// When paging happens anyway, the device writes `--More--`, then erases it
/// with backspaces and spaces when the next page is sent. What lands in a
/// capture is the marker plus a run of control characters, in the middle of
/// the text.
pub fn strip_paging(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let cleaned = line
            .replace("--More--", "")
            .replace("---- More ----", "")
            .replace(['\u{8}', '\r'], "");
        // A line that was nothing but a paging marker becomes empty and should
        // not leave a blank line behind in a configuration file.
        if cleaned.trim().is_empty() && line.contains("More") {
            continue;
        }
        out.push_str(&cleaned);
        out.push('\n');
    }
    out
}

/// Extracts a command's actual output from everything the terminal sent back.
///
/// Removes the echoed command line at the top and the prompt at the bottom,
/// which is everything between "what you typed" and "the device is ready
/// again". Both are present in every response and neither belongs in a saved
/// configuration.
pub fn extract_output(raw: &str, command: &str) -> String {
    let cleaned = strip_paging(raw);
    let mut lines: Vec<&str> = cleaned.lines().collect();

    // Drop everything up to and including the echo of the command. Searching
    // rather than assuming the first line handles the case where a banner or
    // the tail of the previous command is still in the buffer.
    // The echo is rarely a bare line: a device draws its prompt and echoes on
    // the same one, so the buffer holds `SW1#show version`. Matching only the
    // bare form leaves the prompt and the command at the top of every capture.
    let wanted = command.trim();
    let echo = lines.iter().position(|l| {
        let t = l.trim_end();
        if t.trim() == wanted {
            return true;
        }
        match t.strip_suffix(wanted) {
            // Only accept it as an echo if what precedes the command is a
            // prompt, so a configuration line that happens to end with the
            // same text does not truncate the capture.
            Some(head) => {
                let h = head.trim_end();
                h.is_empty() || h.ends_with('#') || h.ends_with('>')
            }
            None => false,
        }
    });
    if let Some(i) = echo {
        lines.drain(..=i);
    }

    // Drop the trailing prompt, and any blank lines above it.
    while let Some(last) = lines.last() {
        if last.trim().is_empty() || find_prompt(last).is_some() {
            lines.pop();
        } else {
            break;
        }
    }
    // And any blank lines the echo left at the top.
    while lines.first().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.remove(0);
    }

    lines.join("\n")
}

/// Whether the device rejected the command.
///
/// Worth detecting because the failure is silent otherwise: `show running-config`
/// without enable returns an error line and nothing else, and saving that to a
/// file produces a "backup" containing an error message.
pub fn command_was_rejected(output: &str) -> Option<String> {
    for line in output.lines().take(5) {
        let t = line.trim();
        if t.starts_with('%')
            || t.starts_with("^%")
            || t.contains("Invalid input detected")
            || t.contains("Incomplete command")
            || t.contains("Permission denied")
            || t.contains("Authorization failed")
        {
            return Some(t.to_string());
        }
    }
    None
}

/// Whether a captured configuration actually looks like one.
///
/// The last line of defence before something is written to a backup file. A
/// capture that is empty, or is an error message, or stopped a few lines in
/// should not be filed alongside real backups where it will be trusted later.
pub fn looks_like_config(text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("the device returned nothing".into());
    }
    if let Some(err) = command_was_rejected(trimmed) {
        return Err(format!("the device rejected the command: {err}"));
    }
    if trimmed.lines().count() < 5 {
        return Err(format!(
            "the device returned only {} line(s), which is not a configuration",
            trimmed.lines().count()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_enable_prompt_is_recognised() {
        let p = find_prompt("something\nCORE-SW-01#").unwrap();
        assert_eq!(p.hostname, "CORE-SW-01");
        assert_eq!(p.text, "CORE-SW-01#");
        assert!(p.enabled);
    }

    #[test]
    fn a_user_mode_prompt_is_recognised_and_flagged() {
        // Worth knowing: show running-config will fail from here.
        let p = find_prompt("EDGE-RTR>").unwrap();
        assert_eq!(p.hostname, "EDGE-RTR");
        assert!(!p.enabled, "> is user mode, not enable");
    }

    #[test]
    fn a_config_mode_prompt_reduces_to_the_hostname() {
        let p = find_prompt("SW1(config-if)#").unwrap();
        assert_eq!(p.hostname, "SW1");
        assert!(p.enabled);
    }

    #[test]
    fn output_still_arriving_is_not_a_prompt() {
        // This is what the read loop uses to decide to keep waiting.
        assert!(find_prompt("Building configuration...").is_none());
        assert!(find_prompt("interface GigabitEthernet0/1").is_none());
        assert!(find_prompt("").is_none());
    }

    #[test]
    fn a_hash_inside_a_configuration_is_not_mistaken_for_a_prompt() {
        // The failure this prevents: a capture truncated at a banner line,
        // producing a config file that is missing everything after it.
        assert!(find_prompt("banner motd #").is_none());
        assert!(find_prompt("! some comment #").is_none());
        assert!(find_prompt("username admin secret 5 $1$xyz#").is_none());
    }

    #[test]
    fn paging_is_detected_in_its_common_forms() {
        assert!(is_paging("line one\n --More-- "));
        assert!(is_paging("line one\n---- More ----"));
        assert!(!is_paging("line one\nSW1#"));
        assert!(!is_paging(""));
    }

    #[test]
    fn paging_markers_are_removed_without_leaving_blank_lines() {
        // What actually lands in a capture: the marker, then the backspaces
        // the device used to erase it.
        let raw = "interface Gi0/1\n --More-- \u{8}\u{8}\u{8}\u{8}\ninterface Gi0/2\n";
        let out = strip_paging(raw);
        assert!(!out.contains("More"));
        assert!(!out.contains('\u{8}'));
        assert_eq!(out, "interface Gi0/1\ninterface Gi0/2\n");
    }

    #[test]
    fn a_commands_output_is_extracted_from_the_echo_and_the_prompt() {
        let raw = "\
show running-config
Building configuration...

Current configuration : 4096 bytes
!
version 15.2
!
hostname CORE-SW-01
!
end

CORE-SW-01#";
        let out = extract_output(raw, "show running-config");
        assert!(out.starts_with("Building configuration..."));
        assert!(out.ends_with("end"), "the prompt should be gone, got: {out:?}");
        assert!(!out.contains("CORE-SW-01#"), "prompt leaked into the capture");
        assert!(!out.starts_with("show running-config"), "echo leaked into the capture");
        assert!(out.contains("hostname CORE-SW-01"));
    }

    #[test]
    fn extraction_survives_leftovers_in_front_of_the_echo() {
        // A banner, or the tail of the previous command, is often still in the
        // buffer when the next one is sent.
        let raw = "\
Unauthorized access prohibited.
SW1#show version
Cisco IOS Software, Version 15.2
SW1#";
        let out = extract_output(raw, "show version");
        assert_eq!(out, "Cisco IOS Software, Version 15.2");
    }

    #[test]
    fn extraction_is_harmless_when_there_is_no_echo_to_find() {
        let raw = "just some output\nSW1#";
        assert_eq!(extract_output(raw, "show version"), "just some output");
    }

    #[test]
    fn a_rejected_command_is_detected() {
        // Without this the error is silently saved as a backup.
        assert!(command_was_rejected("% Invalid input detected at '^' marker.").is_some());
        assert!(command_was_rejected("% Permission denied").is_some());
        assert!(command_was_rejected("^\n% Incomplete command.").is_some());
        assert!(command_was_rejected("hostname SW1\ninterface Gi0/1").is_none());
    }

    #[test]
    fn a_percent_sign_deep_in_a_config_is_not_a_rejection() {
        // Only the first few lines are checked: a rejection comes back
        // immediately, and a config can legitimately contain a % later on.
        let config = (0..40)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n% this appears deep in the file";
        assert!(command_was_rejected(&config).is_none());
    }

    #[test]
    fn a_capture_that_is_not_a_configuration_is_refused() {
        // The last check before something is written to a backup file and
        // trusted later.
        assert!(looks_like_config("").is_err());
        assert!(looks_like_config("   \n  ").is_err());
        assert!(looks_like_config("% Invalid input detected at '^' marker.").is_err());
        assert!(looks_like_config("one\ntwo\nthree").is_err(), "too short to be a config");

        let real = "version 15.2\n!\nhostname SW1\n!\ninterface Gi0/1\n!\nend";
        assert!(looks_like_config(real).is_ok());
    }

    #[test]
    fn the_refusal_says_what_was_wrong() {
        // The message ends up in front of a person deciding whether the device
        // or the credentials are at fault.
        let err = looks_like_config("% Permission denied").unwrap_err();
        assert!(err.contains("rejected"), "got: {err}");
        let err = looks_like_config("").unwrap_err();
        assert!(err.contains("nothing"), "got: {err}");
    }
}
