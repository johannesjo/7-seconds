# Legal and Privacy Requirements for Online PvP in 7 Seconds

**Date:** 2026-03-07
**Status:** Plan
**Context:** Adding online multiplayer via Trystero (WebRTC) + Supabase signaling to a browser/Android game with no user accounts

---

## Architecture Summary (for legal context)

- **Signaling:** Supabase Realtime relays ~5 ephemeral messages (SDP offers, ICE candidates) per match. No persistent storage.
- **Game data:** Flows entirely peer-to-peer via WebRTC DataChannels. DTLS-encrypted by default (mandatory in WebRTC spec).
- **User accounts:** None. No login, no registration, no usernames.
- **Chat:** None.
- **Personal data collected by the app:** None intentionally. However, WebRTC inherently exposes IP addresses between connected peers.
- **Matchmaking:** Share links (no lobby, no matchmaking server).

---

## 1. Privacy Policy

### What needs to be done
Write and publish a privacy policy that covers:
- That the app does not collect personal data, create accounts, or require login
- That WebRTC is used for peer-to-peer connections, which inherently exposes IP addresses between connected peers
- That Supabase processes ephemeral signaling messages (SDP offers, ICE candidates) to establish connections, and where those servers are located
- That WebRTC connections are encrypted (DTLS/SRTP)
- That no game data passes through any server
- That no analytics, tracking, or advertising SDKs are used (if true)
- User rights under GDPR (access, erasure, objection) and how to exercise them
- Contact information for privacy inquiries
- Data controller identity

### Why
- **Google Play Store:** Mandatory for all apps, even those that collect no data. Apps without a privacy policy can be suspended or removed. Must be linked in the Play Store listing AND accessible within the app.
- **GDPR (Art. 13/14):** Required whenever personal data is processed. IP addresses are personal data under GDPR (confirmed in CJEU Breyer case C-582/14 and GDPR Recital 30).
- **CCPA:** IP addresses are considered personal information under CCPA as well.

### Priority
**Must-have before launch.** Google Play will reject or remove apps without one.

### Effort
~2-4 hours to write. Host on a simple web page (e.g., GitHub Pages, or a route within the app). No ongoing maintenance unless features change.

---

## 2. Google Play Data Safety Form

### What needs to be done
Complete the Data Safety section in Google Play Console. Based on the current architecture, the declaration should state:

**Data collected:**
| Data type | Collected | Shared | Purpose | Optional |
|-----------|-----------|--------|---------|----------|
| IP address | Yes (via WebRTC, ephemeral) | Yes (with the other peer) | App functionality (multiplayer) | Yes (only if user chooses to play online) |

**Security practices to declare:**
- Data is encrypted in transit (WebRTC DTLS is mandatory)
- Data is not stored persistently
- Users can not request deletion (nothing is stored)

**Additional declarations:**
- App does not use advertising SDKs
- App does not use analytics SDKs (if true)
- No account creation, so no account deletion flow needed

### Why
- **Google Play policy:** The Data Safety form is mandatory for all apps on Google Play, including internal/testing tracks. Even apps that collect no data must fill it out.

### Priority
**Must-have before launch** (or before updating the existing Play Store listing with multiplayer).

### Effort
~1-2 hours. Straightforward form in Play Console.

---

## 3. GDPR Compliance

### What needs to be done

#### 3a. Identify lawful basis for processing IP addresses
- **Recommended basis: Legitimate Interest (Art. 6(1)(f)).**
  - The IP address exposure is inherent to WebRTC and technically necessary for the multiplayer connection.
  - The user explicitly initiates the connection by choosing to play online and sharing/clicking a link.
  - No IP addresses are logged, stored, or used for any secondary purpose.
  - The CJEU has ruled that systematic gathering of IP addresses in peer-to-peer networks can be lawful.
- Document a **Legitimate Interest Assessment (LIA)** covering:
  - Purpose: Establishing a peer-to-peer connection for multiplayer gameplay
  - Necessity: WebRTC requires IP exchange; there is no alternative
  - Balancing test: Minimal privacy impact (ephemeral, no storage, user-initiated, encrypted)

#### 3b. Supabase as a data processor
- Supabase processes signaling data (which contains IP-related info in ICE candidates) on behalf of the app.
- **Sign Supabase's Data Processing Addendum (DPA).** Available self-service at supabase.com/legal/dpa.
- **Choose an EU region for the Supabase project** (Frankfurt `eu-central-1` recommended) to keep signaling data within the EEA and simplify compliance.

#### 3c. Inform users (via privacy policy, covered in item 1)
- GDPR Art. 13 requires informing users about: what data, why, legal basis, recipients, retention period, and their rights.

### Why
- **GDPR:** IP addresses are personal data. Any processing requires a lawful basis and transparency.
- **Supabase DPA:** Required under GDPR Art. 28 when using a data processor.

### Priority
- LIA documentation: **Must-have before launch** (can be an internal document, does not need to be published).
- Supabase DPA: **Must-have before launch.**
- EU region selection: **Must-have before launch** (choose at project creation time; changing later requires migration).

### Effort
- LIA: ~2-3 hours to write (one-time).
- Supabase DPA: ~30 minutes (self-service signing).
- Region selection: ~5 minutes (during Supabase project setup).

---

## 4. COPPA Compliance (Children's Privacy)

### What needs to be done

#### Assessment: Does COPPA apply?
COPPA applies if the app is **directed at children under 13** OR if the operator has **actual knowledge** that it is collecting personal information from children under 13.

Key factors for 7 Seconds:
- No accounts, no chat, no username creation
- No intentional data collection from anyone
- IP addresses ARE personal information under the updated 2025 COPPA rule (effective June 23, 2025, compliance deadline April 22, 2026)
- IP addresses exchanged via WebRTC could technically constitute "collection" of a persistent identifier

#### Recommended approach
1. **Do NOT market the game as "for children"** or use child-directed language/visuals in the store listing. This avoids being classified as a "child-directed" service.
2. **Do NOT enroll in Google Play's "Designed for Families" program.**
3. **Set the target audience to 13+ (or "not designed for children")** in the Google Play Console content rating and target audience section.
4. **Add an age gate or age disclaimer** if there is any ambiguity about the target audience. A simple "This game includes online multiplayer. You must be 13 or older to use online features" notice before connecting would provide additional protection.
5. If the game IS intended for a general audience including children: consult a lawyer, as COPPA compliance for online multiplayer with IP exposure gets complicated.

#### 2025 COPPA Rule changes (effective April 2026)
The updated COPPA rule:
- Explicitly includes IP addresses as personal information (persistent identifiers)
- Tightens the "internal operations" exception
- Adds biometric identifiers to scope
- Compliance deadline: **April 22, 2026** (before your likely launch window -- verify timeline)

### Why
- **COPPA (15 U.S.C. 6501-6506):** Federal law with significant penalties (up to $50,120 per violation as of 2023).
- **Google Play policy:** Apps targeting children have additional requirements.

### Priority
- Target audience declaration (13+): **Must-have before launch.**
- Age gate for online features: **Should-have before launch** (low effort, significant legal protection).
- Full COPPA compliance review: Only needed if targeting children, which is **not recommended** for this architecture.

### Effort
- Target audience setting: ~10 minutes in Play Console.
- Age gate UI: ~2-4 hours (simple dialog before first online match).
- Legal review (if targeting children): Would require external counsel.

---

## 5. Terms of Service / Terms of Use

### What needs to be done
Write terms of service covering:

1. **Acceptable use policy** -- prohibited behavior (cheating, harassment, abuse of share links)
2. **Disclaimer of warranties** -- service provided "as is," no guaranteed uptime or availability
3. **Limitation of liability** -- not liable for interactions between peers, data exposure via WebRTC, connection issues
4. **P2P connection disclosure** -- users acknowledge that online play creates a direct connection with another player, exposing IP addresses
5. **Third-party services** -- Supabase is used for signaling; link to their terms
6. **Intellectual property** -- game content ownership
7. **Termination/modification** -- right to modify or discontinue the service
8. **Governing law and jurisdiction** -- specify applicable law (likely based on your location)
9. **Age requirement** -- must be 13+ (or local age of digital consent) to use online features

### Why
- **Legal protection:** Limits liability for P2P interactions between players.
- **Google Play policy:** While not strictly required for all apps, strongly recommended for apps with online features.
- **User expectations:** Users should understand the nature of P2P connections before using them.

### Priority
**Should-have before launch.** Not a hard blocker like the privacy policy, but strongly recommended. The most critical element is the P2P/IP exposure disclosure and liability limitation.

### Effort
~3-5 hours to write. Host alongside the privacy policy.

---

## 6. Content Rating (IARC)

### What needs to be done
- Complete or update the **IARC content rating questionnaire** in Google Play Console.
- When answering: indicate that the app has **"Users can interact"** (online multiplayer).
- This will likely result in a **slightly higher age rating** than a purely offline game, but since there is no chat, voice, or user-generated content, the impact should be modest.

### Why
- **Google Play requirement:** All apps must have a content rating. Inaccurate ratings can result in removal.
- **IARC (International Age Rating Coalition):** The questionnaire determines ratings across multiple systems (PEGI, ESRB, etc.).

### Priority
**Must-have before launch** (or before publishing the update).

### Effort
~15-30 minutes. It is a questionnaire in Play Console.

---

## 7. Supabase Configuration

### What needs to be done

| Action | Detail |
|--------|--------|
| Choose EU region | Frankfurt (`eu-central-1`) for GDPR-friendly data residency |
| Sign DPA | Self-service at supabase.com/legal/dpa |
| Verify data retention | Confirm that Realtime messages are not persisted (they are ephemeral by default) |
| Review Supabase privacy policy | Link to it from your own privacy policy as a sub-processor |
| RLS / security | Ensure Realtime channels are scoped so players can only access their own signaling room |

### Why
- **GDPR Art. 28:** Requires a DPA with any data processor.
- **GDPR Art. 44-49:** Data transfers outside the EEA require additional safeguards (choosing an EU region avoids this for the database; note that Supabase uses additional infrastructure from Cloudflare, Fly.io, etc.).
- **Security:** Prevent abuse of the signaling channel.

### Notes on Supabase infrastructure
- Database: AWS (region you choose)
- Logs: BigQuery (Google Cloud) -- verify if signaling generates logs containing IP addresses
- Realtime: Hosted by Supabase -- confirm data residency
- Edge Functions: Deno Deploy (region not directly controllable) -- but you are not using Edge Functions for signaling

### Priority
**Must-have before launch** (region choice is especially important as migration is costly).

### Effort
~1-2 hours total.

---

## 8. ePrivacy / Cookie Considerations

### What needs to be done
- Verify that neither Trystero nor the Supabase client SDK stores anything in localStorage, sessionStorage, or cookies beyond what is strictly necessary for the connection.
- If any storage is used purely for technical necessity (e.g., a session token for the Realtime channel), this falls under the "strictly necessary" exemption and does not require consent.
- If no cookies or tracking storage is used: **no cookie banner is needed.**

### Why
- **ePrivacy Directive (Art. 5(3)):** Requires consent for storing/accessing information on a user's device, unless strictly necessary.

### Priority
**Should verify before launch.** Likely no action needed if no tracking is present.

### Effort
~1 hour to audit the client-side storage behavior of Trystero and the Supabase JS client.

---

## 9. WebRTC IP Address Mitigation (Optional but Recommended)

### What needs to be done
- **Inform users** in the privacy policy and in-app (before first online match) that playing online will expose their IP address to the other player.
- **Consider using a TURN relay** as a fallback. While this routes traffic through a server (removing the pure P2P benefit), some percentage of WebRTC connections already require TURN for NAT traversal. A TURN server would hide both players' IP addresses from each other.
  - Note: Running a TURN server has cost and infrastructure implications.
- **Document that mDNS is used by modern browsers** to hide local/private IP addresses (but public IP is still exposed in all cases for P2P connections).

### Why
- **GDPR data minimization (Art. 5(1)(c)):** Process only what is necessary. Since IP exposure is inherent to WebRTC P2P, this is defensible, but offering a relay option demonstrates good faith.
- **User trust:** Transparency about IP exposure builds trust.

### Priority
- In-app disclosure: **Should-have before launch.**
- TURN relay: **Nice-to-have.** Significant infrastructure cost; only consider if user base grows or privacy complaints arise.

### Effort
- In-app notice: ~1-2 hours.
- TURN server setup: ~1-2 days + ongoing cost.

---

## Summary: Launch Checklist

### Must-have before launch

| Item | Effort | Regulation/Requirement |
|------|--------|----------------------|
| Privacy policy (written + hosted) | 2-4 hours | Google Play, GDPR, CCPA |
| Privacy policy linked in Play Store listing | 10 min | Google Play |
| Privacy policy accessible in-app | 1-2 hours | Google Play |
| Google Play Data Safety form | 1-2 hours | Google Play |
| IARC content rating update | 15-30 min | Google Play |
| Target audience set to 13+ | 10 min | COPPA, Google Play |
| Supabase DPA signed | 30 min | GDPR Art. 28 |
| Supabase project in EU region | 5 min | GDPR data residency |
| Legitimate Interest Assessment (internal doc) | 2-3 hours | GDPR Art. 6(1)(f) |

**Total must-have effort: ~8-13 hours**

### Should-have before launch

| Item | Effort | Reason |
|------|--------|--------|
| Terms of Service | 3-5 hours | Liability protection |
| Age gate for online features (13+) | 2-4 hours | COPPA protection |
| In-app disclosure before first P2P connection | 1-2 hours | Transparency, GDPR |
| Audit client-side storage (cookies/localStorage) | 1 hour | ePrivacy |

**Total should-have effort: ~7-12 hours**

### Nice-to-have (post-launch)

| Item | Effort | Reason |
|------|--------|--------|
| TURN relay server for IP privacy | 1-2 days + ongoing cost | Data minimization |
| Legal review by external counsel | Varies | Risk mitigation |

---

## Key Sources

- [GDPR and IP Addresses as Personal Data](https://www.cookieyes.com/blog/ip-address-personal-data-gdpr/) -- CookieYes
- [CJEU Breyer Case on Dynamic IP Addresses](https://ccdcoe.org/incyder-articles/cjeu-determines-dynamic-ip-addresses-can-be-personal-data-but-can-also-be-processed-for-operability-purposes/) -- CCDCOE
- [Google Play Data Safety Section](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) -- Google
- [Google Play Privacy Policy Requirements](https://termly.io/resources/articles/google-play-store-privacy-policy-updates/) -- Termly
- [FTC COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions) -- FTC
- [2025 COPPA Rule Update](https://www.finnegan.com/en/insights/articles/the-ftcs-updated-coppa-rule-redefining-childrens-digital-privacy-protection.html) -- Finnegan
- [Supabase DPA](https://supabase.com/legal/dpa) -- Supabase
- [Supabase Available Regions](https://supabase.com/docs/guides/platform/regions) -- Supabase
- [Supabase Privacy Policy](https://supabase.com/privacy) -- Supabase
- [WebRTC Security and Encryption](https://www.wowza.com/blog/webrtc-encryption-and-security) -- Wowza
- [WebRTC mDNS Privacy](https://bloggeek.me/psa-mdns-and-local-ice-candidates-are-coming/) -- BlogGeek.me
- [Terms and Conditions for Games](https://www.termsfeed.com/blog/terms-conditions-games/) -- TermsFeed
- [COPPA and Children's Games](https://www.fishinabottle.com/blog/what-does-coppa-and-gdpr-k-compliance-mean-for-childrens-games-fish-in-a-bottle) -- Fish in a Bottle
- [GDPR Legitimate Interest and IP Addresses](https://interlir.com/2024/08/01/gdpr-compliance-in-ip-address-management/) -- Interlir

---

*Disclaimer: This plan is based on research and is not legal advice. For definitive compliance, consult a qualified attorney familiar with digital privacy law in your target jurisdictions.*
