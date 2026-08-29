# Signing the Windows installer

## What the current certificate does, and does not, do

The certificate in hand is issued by **COREVIEW-FGT-Root-CA** — an internal
CA, not one in the Microsoft Trusted Root Program. Its extended key usage is
`Code Signing` (critical) and it runs to August 2036, so it signs correctly.
What that is worth depends entirely on who is running the installer.

| | Machine that trusts COREVIEW-FGT-Root-CA | Any other machine |
| --- | --- | --- |
| Signature validates | Yes | No |
| Publisher shown | COREVIEW | "Unknown Publisher" |
| Tamper-evident | Yes | Yes — the hash is still checked |
| SmartScreen warning | Still possible on a new file | **Yes, unchanged** |

SmartScreen reputation attaches to the signing certificate, and an internal CA
has none with Microsoft and cannot earn any. Signing with this certificate is
worth doing — it is free, it proves the installer came from you and has not
been altered, and it names the publisher on managed machines. It does not make
the warning go away for anyone outside the estate, and no amount of
configuration changes that.

**If the warning is the goal**, it needs an OV or EV code-signing certificate
from a public CA. Since June 2023 the private key for one must live in a
FIPS 140-2 Level 2 HSM, so it arrives on a token or through a cloud signing
service — a base64 PFX in a CI secret is no longer possible for those. Azure
Trusted Signing is the least painful current route. EV earns reputation
immediately; OV builds it over downloads and time.

## Setting it up

Two repository secrets, at **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `WINDOWS_CERTIFICATE` | `base64 -w0 coreview-codesign.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | the PFX password |

Nothing else. The thumbprint is read back from the certificate after it is
imported rather than kept as a constant here, so replacing the certificate
needs no change to the repository.

With no secrets configured — forks, pull requests, or before this is set up —
the build says so and produces an unsigned installer rather than failing.

## What the build does

`.github/actions/sign-windows` imports the PFX into the runner's certificate
store, deletes the file, and points the Tauri bundler at the imported key by
thumbprint. Signatures are timestamped against
`http://timestamp.digicert.com`: without a timestamp a signature stops
validating the day the certificate expires, and an installer outlives that.

Both Windows artifacts are signed — the 7 MB default and the 500 MB offline
one.

## Checking a build

On Windows:

```powershell
Get-AuthenticodeSignature .\Coreview_0.2.0_x64-setup.exe | Format-List
```

`Status` reads `Valid` on a machine that trusts the root, and
`UnknownError` / `NotTrusted` on one that does not — which is the expected
result outside the estate, not a fault in the build.
