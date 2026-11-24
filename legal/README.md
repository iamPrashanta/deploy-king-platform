# Deploy King legal documents

> **Status: DRAFT, not yet in force.** These documents were written as a starting point. Have a lawyer in India review them before you take your first paid customer, and again before you sell to the EU, the UK or California. Fill in every `[bracketed]` value first.

| Document | What it is for | Where it must appear |
| --- | --- | --- |
| [PRIVACY_POLICY.md](PRIVACY_POLICY.md) | What personal data Deploy King Cloud and Desktop collect, why, for how long, and people's rights | Website footer, sign-up screen, inside the desktop app |
| [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md) | The contract for using Deploy King Desktop and Deploy King Cloud, including subscriptions | Website footer, sign-up screen (tick box), checkout |
| [REFUND_POLICY.md](REFUND_POLICY.md) | Cancellations, refunds and failed payments | Website footer, pricing page, checkout. Payment providers such as Razorpay ask for this page during merchant review. |
| [ACCEPTABLE_USE_POLICY.md](ACCEPTABLE_USE_POLICY.md) | What users may not do with the product and the AI | Linked from the Terms |
| [CLA.md](CLA.md) | Contributor License Agreement: lets you keep licensing the code (FSL today, anything later) after outside people contribute | Linked from CONTRIBUTING.md and the pull request template |
| [../SECURITY.md](../SECURITY.md) | How people report security problems to you | Repository root (GitHub shows it on the Security tab) |

The **code** of this repository is licensed under [FSL-1.1-ALv2](../LICENSE). These documents cover the **products and services** you run on top of it. A self-hosted installation of the open platform is operated by whoever installs it; these policies apply to it only where that installation talks to Deploy King Cloud.

## Values to fill in

| Placeholder | Example / note |
| --- | --- |
| `[Legal name]` | Your name as a sole proprietor, or your company's registered name once you form one (a private limited company or LLP limits your personal liability) |
| `[Registered address]` | Required to be displayed under India's Consumer Protection (E-Commerce) Rules, 2020 |
| `[Grievance Officer name]` | A real person; the same rules require the name, designation and contact details to be displayed |
| `[support email]`, `[privacy email]`, `[security email]` | Use addresses on your product domain, e.g. `privacy@<your-domain>` |
| `[website]` | e.g. `https://<your-domain>` |
| `[GSTIN]` | Once registered for GST |
| `[hosting region]` | Where Deploy King Cloud's servers are, e.g. "India (Mumbai)" |
| `[effective date]` | The day you publish each document |

## Compliance checklist

### India

- **Digital Personal Data Protection Act, 2023 and DPDP Rules, 2025.** Most duties apply from 13 May 2027; build for them now.
  - itemised notice and consent before collecting data
  - easy withdrawal of consent
  - answer access, correction and erasure requests within at most 90 days
  - breach notice to affected users without delay, and a detailed report to the Data Protection Board within 72 hours
  - verifiable parental consent for anyone under 18 (simplest: do not accept users under 18)
- **CERT-In Directions (2022, under the IT Act section 70B).**
  - Report specified cyber incidents to CERT-In within 6 hours of noticing them.
  - Keep logs of your ICT systems for a rolling 180 days, within India.
  - Name a point of contact with CERT-In.
- **Consumer Protection Act, 2019 and E-Commerce Rules, 2020.**
  - Display your legal name, address, website, and customer care and Grievance Officer contacts.
  - Acknowledge complaints within 48 hours and resolve them within one month.
  - Show prices including taxes.
  - No dark patterns: cancellation must be as easy as sign-up.
- **IT Act, 2000 and the SPDI Rules, 2011:** reasonable security practices (follow and document something like ISO 27001-style controls). The SPDI Rules are replaced as DPDP comes fully into force.
- **RBI Digital Payments E-mandate Framework, 2026:**
  - The first payment of a subscription needs OTP or PIN (AFA).
  - Later renewals up to ₹15,000 are charged automatically.
  - Customers get a notice before each debit.
  - Your payment provider handles the mechanics; your Terms and Refund Policy must match it.
- **GST:** register once you pass the threshold, or from day one if you sell to customers outside your state or abroad (ask a CA). Charge GST on Indian sales and issue invoices. Exports of services may be zero-rated with a LUT.
- **Income tax and records:** keep invoices and books for as long as tax and company law require (ask your CA; often 6–8 years).

### Worldwide

- **EU and UK (GDPR / UK GDPR).** Applies as soon as you offer the service to people there.
  - a lawful basis for each use of data (in the Privacy Policy)
  - a Data Processing Agreement with every provider that handles personal data for you
  - Standard Contractual Clauses for transfers outside the EU and UK
  - report breaches to the supervisory authority within 72 hours
  - very likely an EU and a UK representative (GDPR Article 27), since you have no office there
  - EU and UK consumers have a 14-day withdrawal right for online purchases, which they lose for digital services once they ask the service to start (see the Refund Policy)
- **United States.** California (CCPA/CPRA) and other state privacy laws apply once you pass their revenue or data-volume thresholds. Be honest that you do not sell or share personal data for advertising, and honour "Do Not Sell or Share" and Global Privacy Control signals on the website.
- **Sales tax and VAT abroad:** a merchant of record (Paddle, Lemon Squeezy) collects and pays VAT/GST/sales tax for you in other countries. Recommended until you are large.
- **Export controls and sanctions:** do not sell to sanctioned countries or people (Terms, section 14).
- **Cookies:** essential cookies only by default. Ask for consent before analytics or marketing cookies (EU/UK ePrivacy rules; DPDP consent).

### Before launch

1. Fill in the placeholders, and get a lawyer's review.
2. Publish the four policies on the website and link them in the app.
3. Add a sign-up tick box: "I agree to the Terms of Service and have read the Privacy Policy" (not pre-ticked), and record who agreed to which version and when.
4. Appoint and display the Grievance Officer.
5. Set up 180-day log retention and an incident-response runbook with the 6-hour CERT-In and 72-hour DPDP/GDPR deadlines.
6. Sign Data Processing Agreements with your providers (hosting, email, payments, AI).
7. Enable GitHub private vulnerability reporting (repository Settings → Security).
8. Ask contributors to sign the CLA before you merge their pull requests.
