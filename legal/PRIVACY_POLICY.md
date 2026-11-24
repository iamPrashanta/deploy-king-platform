# Privacy Policy

> DRAFT. Not in force until published with an effective date. Fill in all `[bracketed]` values and have it reviewed by a lawyer.

**Effective date:** [effective date]
**Version:** 1.0

This Privacy Policy explains how **[Legal name]** ("Deploy King", "we", "us") handles personal data when you use **Deploy King Cloud** (our online service), **Deploy King Desktop** (our app for Windows and macOS) and our website **[website]** (together, the "Services").

Under India's Digital Personal Data Protection Act, 2023 we are the **Data Fiduciary**. Under the EU and UK GDPR we are the **controller**.

**This policy does not cover** a copy of the open-source Deploy King platform that someone installs on their own server. Whoever runs that server decides what happens to the data on it. We receive nothing from such a server unless it is connected to Deploy King Cloud.

## 1. Summary

- We collect what we need to run your account, check your plan, bill you, and keep the Services working and safe.
- **We never upload your source code, the contents of your ZIP files, your environment variable values, passwords or keys, or your apps' databases.** They stay on your computer, inside Deploy King Desktop's private virtual machine.
- Deploy logs leave your computer only when you choose to send them (for example with "Ask AI about this"). Secrets are hidden before they leave.
- We do not sell your personal data, and we do not use it for advertising.

## 2. What we collect

| Category | Examples | Source |
| --- | --- | --- |
| Account | Name, email address, password hash or sign-in provider (Google, GitHub), plan, account settings | You |
| Devices | A random device ID, device name, operating system and version, app version | Deploy King Desktop |
| Usage events | Each action you ask Deploy King to perform (deploy, change, delete, scheduled job, worker): its type, time, result, duration, error code, project type (Node, PHP, static…), upload size, number of apps | Deploy King Desktop and Cloud |
| Billing | Plan, billing country and state (for tax), GSTIN if you give one, invoices, payment status. **Card, UPI and bank details are collected and stored by our payment providers, not by us.** | You and our payment providers |
| Support and AI | Your messages to support, your questions to the AI assistant, and anything you choose to attach (such as log lines, which have secrets hidden) | You |
| Security logs | IP address, sign-in times, failed sign-ins, API requests to Deploy King Cloud | Our servers |
| Website | Pages visited and essential cookies. Analytics cookies only if you agree. | Your browser |
| Optional (opt-in) | Crash reports; anonymised error patterns used to improve our fix library | Deploy King Desktop, only if you turn it on |

You can use the Services without giving us more than the account details. If you do not give the account details, we cannot provide the Services, because every action is checked against your account.

## 3. Why we use it, and our legal basis

| Purpose | Data used | Legal basis (GDPR) |
| --- | --- | --- |
| Create and run your account; sign in on your devices | Account, devices | Contract |
| Check your plan and quota before each action, and record the result | Usage events, devices | Contract |
| Billing, invoices and tax | Billing | Contract; legal obligation |
| Answer support requests and AI questions | Support and AI | Contract |
| Security: prevent abuse, fraud and attacks; meet incident-reporting and log-keeping duties | Security logs, usage events | Legitimate interests; legal obligation |
| Improve the Services (aggregated usage statistics, failure rates by project type) | Usage events, aggregated | Legitimate interests |
| Improve the AI fix library using anonymised error patterns | Optional data | Consent |
| Product emails (new features, offers) | Email | Consent (you can unsubscribe any time) |

In India we process your personal data on the basis of your **consent**, given when you create an account, and for the legitimate uses the DPDP Act allows (for example to meet legal obligations). You may withdraw consent at any time (section 8). Withdrawal does not affect processing already done. If you withdraw consent needed to run the Services, we will have to close your account.

## 4. The AI assistant

- Your questions, and anything you choose to attach, are sent to an AI model provider that works for us as a processor, to produce an answer: [AI provider, e.g. Anthropic].
- Under our agreement with them, they do not use this data to train their models.
- We keep AI conversations for [90] days so you can see your history, then delete them.
- We may turn **anonymised** patterns (for example "error X in a Node app was fixed by setting PORT") into entries in our fix library, only if you opted in. Fix-library entries contain no personal data.
- AI answers can be wrong. Check a suggested change before you apply it.

## 5. Who we share it with

We share personal data only with providers who process it for us, under written agreements, and only as much as they need:

| Provider type | Name | Purpose | Location |
| --- | --- | --- | --- |
| Cloud hosting | [e.g. provider] | Runs Deploy King Cloud | [hosting region] |
| Network and security | [e.g. Cloudflare] | Protects and speeds up our website and API | Worldwide |
| Payments (India) | [e.g. Razorpay] | Takes payments | India |
| Payments (other countries) | [e.g. Paddle] | Takes payments and handles sales tax as merchant of record | [location] |
| Email | [e.g. provider] | Sends account and billing emails | [location] |
| AI model | [e.g. Anthropic] | Answers AI assistant questions | [location] |

We also disclose personal data when the law requires it (for example a valid order from a court or authority), to protect the Services and their users from fraud or attack, or as part of a merger or sale of the business, in which case this policy continues to apply.

We keep this list up to date at [website]/legal/processors.

## 6. International transfers

Deploy King Cloud runs in [hosting region]. Some providers above process data in other countries. Transfers from India follow any restrictions the Government of India notifies under the DPDP Act. For data from the EU or UK, we use the European Commission's Standard Contractual Clauses (and the UK addendum), or another lawful transfer mechanism.

## 7. How long we keep it

| Data | Kept for |
| --- | --- |
| Account | While your account is open. Deleted within 30 days after you close it, except as listed below. |
| Usage events | 24 months, then deleted or aggregated so they no longer identify you |
| Security logs | 180 days (required by Indian law), longer only while investigating an incident |
| AI conversations | [90] days |
| Support messages | 24 months after the request is closed |
| Invoices and billing records | As long as tax and accounting law requires (in India, generally up to 8 years) |
| Optional crash reports | 90 days |

If an account is inactive for [3 years], we will email you, and delete it if you do not reply within 48 hours of the deadline we give.

## 8. Your rights

Depending on where you live, you have the right to:

- **access** the personal data we hold about you, and a summary of how we process it;
- **correct**, complete or update it;
- **erase** it (we keep only what the law requires us to keep);
- **withdraw consent** at any time, as easily as you gave it;
- **nominate** another person to exercise your rights if you die or become unable to (India);
- **receive** your data in a portable format, and **object** to or **restrict** certain processing (EU/UK);
- **know**, **delete** and **correct**, and to **opt out** of the sale or sharing of personal data (California and other US states). We do not sell or share personal data, and we honour Global Privacy Control signals;
- **complain** to us (section 10), and then to the Data Protection Board of India, or to your local data protection authority in the EU or UK.

To use a right, go to **Settings → Privacy** in Deploy King Desktop or at [website]/account, or email [privacy email]. We may ask you to confirm your identity. We answer within 30 days (at most 90 days where Indian law allows it, and one month, extendable in complex cases as GDPR allows). We do not charge for this and will not treat you differently for using your rights.

## 9. Security

- Data is encrypted in transit (TLS) and at rest.
- Access is limited to staff who need it and protected with two-step sign-in.
- Activity is logged and keys are rotated.
- Deploy King Desktop stores your sign-in token in your operating system's protected storage (Windows Credential Manager or macOS Keychain).

**If a breach affects your personal data,** we will tell you without undue delay: what happened, what it means for you, what we are doing, and what you can do. We will also report it to the authorities within the time the law requires: in India, CERT-In within 6 hours and a detailed report to the Data Protection Board within 72 hours; in the EU and UK, the supervisory authority within 72 hours.

## 10. Grievance Officer and contact

**Grievance Officer:** [Grievance Officer name], [designation]
**Email:** [privacy email]
**Address:** [Legal name], [Registered address]

We acknowledge complaints within 48 hours and aim to resolve them within one month.

**EU representative:** [name and address, once appointed]
**UK representative:** [name and address, once appointed]

## 11. Children

The Services are not for anyone under 18. We do not knowingly collect personal data from children. If you believe a child has given us personal data, email [privacy email] and we will delete it.

## 12. Changes

If we change this policy, we will update the effective date. If the change is significant, we will tell you by email or in the app at least 14 days before it takes effect. Where the law requires, we will ask for your consent again.
