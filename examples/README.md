# Example CSVs

Two files for the **From CSV** tab, which builds a diagram from a spreadsheet.
Import the devices first: links are matched against the device names already on
the diagram, so a link whose endpoints are not there yet is skipped and says so.

## devices.csv

`name` is the only required column. Everything else is used when present and
ignored when not, and the header is matched loosely — `ip`, `address`,
`hostname` and `ip/hostname` all mean the same thing, and case, spaces and
underscores do not matter.

| Column | Meaning |
| --- | --- |
| `name` | What the device is called. Required; a row without one is skipped and reported |
| `type` | A device glyph, by name or id — `core switch`, `core-switch`, `firewall`, `access point`… Anything unrecognised becomes a generic box |
| `ip` | The address to check. A row without one becomes a box on the diagram with nothing watching it |
| `probe type` | `icmp`, `tcp`, `dns` or `manual`. Defaults to `icmp` |
| `port` | For `tcp`. Defaults to 443 |
| `tags` | Separated by `;` or `\|` |
| `notes` | Free text, kept on the device |

## links.csv

`source` and `target` are required and are device **names**, because a
spreadsheet has no way to know the ids Coreview generates. Matching ignores
case.

| Column | Meaning |
| --- | --- |
| `source`, `target` | Device names, matched against the diagram |
| `source port`, `target port` | Interface labels shown at each end |
| `link label` | Text on the middle of the link |
| `health rule` | `both-endpoints` (default), `follow-source`, `follow-target`, `manual`, `dedicated-probe`, `named-node-probe` |
