// Points the Tauri bundler at an already-imported signing certificate.
//
// Node rather than PowerShell's ConvertTo-Json: PowerShell serialises a
// single-element array as a scalar, and this config has one (`deb.depends`).
// Only the Windows bundle reads the file here, but a step that quietly
// corrupts the project's configuration is not worth the convenience.
import { readFileSync, writeFileSync } from 'node:fs';

const [thumbprint] = process.argv.slice(2);
if (!thumbprint) {
  console.error('usage: configure.mjs <thumbprint>');
  process.exit(1);
}

const path = 'src-tauri/tauri.conf.json';
const config = JSON.parse(readFileSync(path, 'utf8'));
config.bundle.windows.certificateThumbprint = thumbprint;
config.bundle.windows.digestAlgorithm = 'sha256';
// A signature with no timestamp stops validating the day the certificate
// expires. A timestamped one keeps validating afterwards, which matters for
// an installer people keep for years.
config.bundle.windows.timestampUrl = 'http://timestamp.digicert.com';
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Bundler will sign with ${thumbprint}, timestamped.`);
