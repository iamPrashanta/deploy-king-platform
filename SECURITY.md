# Security policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately in either of these ways:

1. **GitHub:** open the repository's **Security** tab and choose **Report a vulnerability**.
2. **Email:** [security email]. Encrypt with our PGP key, if you have it: [key link].

Please include:
- what is affected (platform, installer, server watch, Deploy King Desktop, Deploy King Cloud)
- the version or commit
- steps to reproduce
- what an attacker could do

## What happens next

| Step | Target |
| --- | --- |
| We acknowledge your report | within 3 working days |
| We confirm whether it is a problem, and how serious | within 10 working days |
| Fix released for critical and high issues | within 30 days, sooner if it is being exploited |
| Public advisory, crediting you if you want | when the fix is out |

We keep you updated, and agree a disclosure date with you. There is no paid bug bounty yet.

## Safe harbour

We will not pursue legal action against research that:
- is done in good faith and follows this policy
- uses only your own accounts and test installations
- avoids harm to other people's data, privacy and service, and accesses no more than needed to show the problem
- gives us a reasonable time to fix the problem before you disclose it

## Out of scope

- Denial-of-service and volume attacks
- Social engineering, physical attacks
- Problems only in outdated versions
- Reports from automated scanners with no shown impact
- Missing best-practice headers with no shown impact
- Attacks that need an already compromised device or root access on the server, unless they cross a boundary Deploy King promises (for example a container app reaching the host)

## Supported versions

Security fixes go into the latest release line (`v3.x`) and the current Deploy King Desktop release. Older lines receive fixes only for critical issues, at our discretion.
