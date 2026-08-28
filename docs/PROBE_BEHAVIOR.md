# Probe behaviour

The authoritative implementation is `crates/livetopo-probe/src/state.rs` for
thresholds and `icmp.rs` / `net.rs` for the checks. Both have unit tests.

## Statuses

```
unknown | healthy | warning | down | disabled | maintenance
```

## ICMP

Runs the platform `ping` binary with an argument vector — never a shell string.

- Windows: `ping.exe -n 1 -w <timeout_ms> [-4|-6] <target>`
- Linux/macOS (dev only): `ping -c 1 -W <ceil(timeout_ms/1000)> <target>`

One echo request per check. `CREATE_NO_WINDOW` is set on Windows so no console
flashes. The child is killed if the task is dropped, and a wall-clock guard of
`timeout + 2000 ms` prevents a wedged child from holding a scheduler slot.

Output is parsed as text, because exit codes lie: Windows `ping.exe` can return
0 for *Destination host unreachable*. Recognised results:

| Output contains | Result |
| --- | --- |
| `could not find host`, `name or service not known`, `unknown host` | DNS failure |
| `destination host/net unreachable`, `network is unreachable` | Unreachable |
| `request timed out`, `100% packet loss` | Timeout |
| `time=<n>ms` or `time<1ms` | Success, RTT captured |
| anything else with exit 0 | Success, no RTT |
| anything else | OS error, with the first line of output shown verbatim |

`time<1ms` is recorded as sub-millisecond and displayed as `<1 ms`. The reason
text is always surfaced; the app never collapses these into a bare "down".

## TCP

A connect with a timeout, then an immediate close. RTT is the connect time.

| Condition | Result | Healthy? |
| --- | --- | --- |
| Connection established | Success | Yes |
| `ConnectionRefused` | Refused | No — something answered, but not what you asked for |
| Timeout expired | Timeout | No |
| Resolver failure | DNS failure | No |
| Unreachable | Unreachable | No |
| Anything else | OS error, message preserved | No |

Refused is deliberately distinct from timeout in the log: a refusal means the
host is up and the port is closed, which is often the more useful fact.

## DNS

Resolves through the OS resolver, bounded by the timeout. Success lists every
returned address in the result summary. An empty answer is a distinct result
from a lookup error, and both count as failures against the threshold.

## Threshold state machine

State starts at `unknown` and stays there until a result arrives. Then, per
result:

**On success**
- Failure count resets to zero, success count increments.
- If RTT is above *Warn above*, the candidate status is `warning`; otherwise
  `healthy`.
- If the previous status was `down`, the candidate is only applied once the
  success count reaches *Recover after*. Until then the object stays red.

**On failure**
- Success count resets to zero, failure count increments.
- If the failure count has reached *Fail after*, status becomes `down`.
- Otherwise the previous healthy or warning status is held, and the detail line
  reads `Request timed out (failure 1 of 3)`.
- If nothing has ever succeeded, status stays `unknown` rather than `healthy`.
  The app does not report health it has not observed.

**Overrides**
- A disabled probe reports `disabled` regardless of results.
- Maintenance reports `maintenance` while still updating counters underneath, so
  the log keeps the real observations.

**Events**
- Written only on a status change. A hundred identical successes produce one
  event, not a hundred.
- Every event carries: timestamp, object type and name, previous status, new
  status, probe type, target, RTT and the detail text.

## Defaults

| Setting | Default |
| --- | --- |
| Interval | 5 s |
| Timeout | 1000 ms |
| Fail after | 3 consecutive failures |
| Recover after | 1 consecutive success |
| Warn above | 100 ms |
| Max concurrent probes | 20 |
| Start stagger | `index * 137 ms`, wrapped at 3 s |

## Validation limits

Enforced in `validate.rs` before anything reaches the OS:

- Target: 1–253 characters; IPv4, IPv6 (bracketed or not), or a hostname of
  1–63-character labels using `a-z 0-9 - _` and dots. Leading dashes and
  leading/trailing hyphens in a label are rejected.
- Port: 1–65535. Interval: 1–86400 s. Timeout: 100–60000 ms. Thresholds: 1–100.

Anything else fails closed with `invalid_target` and never runs a process.
