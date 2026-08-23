# BlackRail: Private Payment Gateway on Solana

> **Every payment hides your business. Every address dies after one use.**

Live demo: [blackrail.xyz](https://blackrail.xyz)  
Merchant portal: [blackrail.xyz/pages/dashboard.html](https://blackrail.xyz/pages/dashboard.html)  
API: [mirage-production-6dfc.up.railway.app](https://mirage-production-6dfc.up.railway.app)

---

## The Problem

Public blockchains are surveillance infrastructure for your competitors.

When anyone accepts crypto payments to a fixed wallet address, every detail is permanently visible on-chain: total revenue, order frequency, biggest customers, slow months, transaction sizes. A Solana wallet address is a public business ledger that anyone with a browser can read in real time.

Banks and centralized payment processors have always kept this data private by default. Stripe, Paystack, PayPal, and every bank in the world hold your revenue figures behind closed doors. The merchant sees them. The processor sees them. Nobody else does.

But centralized systems have a different problem: **they own your data, and they sell it.**

Cases are well-documented across both US and Nigerian fintech markets where centralized processors and financial institutions have monetized sensitive merchant data, including total revenue figures, sales velocity, loss patterns, and customer behaviour, by selling aggregated or identifiable data to competitors, insurers, lenders, and data brokers willing to pay for it. Paystack, Stripe, and PayPal all operate under terms of service that permit broad data sharing for "business purposes." The merchant never knows.

Crypto fixes the centralization problem but introduces a worse one: the data is now public to everyone, not just the processor.

BlackRail fixes both.

---

## Proven Demand: What We Are Building On

BlackRail draws direct inspiration from the payment infrastructure that already processes billions in volume. These products proved the market exists. BlackRail extends them into the privacy layer they were never designed to have.

**Stripe (US):** The global standard for developer payment APIs. Stripe processes hundreds of billions annually and built the concept of checkout sessions, webhook-driven settlement, and API-first merchant tooling. BlackRail's session model, API surface, and dashboard UX are directly inspired by Stripe. What Stripe cannot offer: any form of on-chain privacy.

**Paystack (Nigeria/Africa):** Acquired by Stripe for $200M. Built the same checkout session model for African merchants and proved massive demand for developer-friendly payment infrastructure in emerging markets. Nigerian merchants specifically face elevated risk from data exposure due to inconsistent data protection enforcement. BlackRail's privacy guarantees are especially relevant here.

**PayPal (Global):** The original internet payment layer. 400M+ active users. PayPal proved that merchants want abstraction between the payer and their real financial identity. BlackRail brings that abstraction to crypto natively.

**The gap all three share:** They are centralized. They hold the data. They can sell it, subpoena it, or leak it. BlackRail is the first implementation of the payment session model that is private by cryptographic architecture, not by policy.

---

## Who BlackRail Is Built For

BlackRail was built with merchants as the primary user but the architecture serves anyone who receives payments and values financial privacy:

- **Merchants** accepting crypto who do not want competitors tracking their revenue
- **Freelancers and agencies** invoicing clients without exposing their full transaction history
- **DAOs and protocol treasuries** receiving contributions without revealing treasury inflows
- **Individuals** receiving peer payments without linking their identity to a permanent address
- **Any operator** in a jurisdiction where financial surveillance poses a legal or personal risk

The merchant portal is the first surface. The primitive is universal.

---

## What BlackRail Does

BlackRail is a private payment gateway. Every checkout session generates a **disposable, one-time facade address**. The buyer pays it on-chain like any normal SPL transfer. The real vault address never appears anywhere in the transaction trail.

The facade is swept to the private vault using **MagicBlock's Private Ephemeral Rollup infrastructure**, routing funds through MagicBlock's internal ER network rather than a direct on-chain transfer, breaking the public link between payer and recipient.

```
Buyer wallet  -->  Ephemeral facade  -->  [MagicBlock ER]  -->  Merchant vault
  (public)           (disposable)            (private)            (hidden)
```

After settlement, the facade address is destroyed. The on-chain record shows a payment to an address that no longer exists and cannot be traced back to the vault.

**Implementation note:** In the current demo, the vault is represented by the vault wallet's USDC associated token account (`B82AzAWZ...`), owned by `2QGJqSPW...`. The token account itself is a normal public Solana account; the privacy comes from the settlement path that separates the disposable facade from the vault, not from hiding the vault account.

Private settlement is attempted for qualifying transfers. If a transfer is below the gasless minimum or the MagicBlock private request cannot complete, the system falls back to a standard public SPL settlement.

---

## Why This Is an Ephemeral Rollups Use Case

MagicBlock's Ephemeral Rollups are not just for games. They are **programmable private state transitions**, and payment settlement is exactly that: a state change (facade to vault) that should be private, atomic, and fast.

BlackRail uses the **MagicBlock Payments API (`/v1/spl/transfer` with `visibility: "private"`)** to route the sweep through MagicBlock's ER infrastructure. The on-chain settlement does not show a direct facade-to-vault SPL transfer. It routes through MagicBlock's internal ephemeral network (`EiV97...`), surfacing on-chain only at the vault receive, with no readable link to the source facade.

This is the core primitive that makes BlackRail possible. Without private ER routing, the sweep is visible on-chain and the privacy guarantee collapses.

### Beyond Unlinking: Splits and Delayed Release

The same PER transfer call that breaks the sender/destination link also supports
configurable **split payments** and **time delayed disbursement**, both set at the
point of delegation and encrypted client-side, meaning even MagicBlock's own
infrastructure can't see recipient breakdown or release timing until settlement.

BlackRail's current settlement path uses a single recipient, immediate release
transfer. Splits and delay aren't used in this build, but they're a natural next
step for the merchant-facing product: automatic platform-fee routing on
settlement, or a delayed release window for refund eligible orders, both without
any additional infrastructure, since the primitive already supports it.


---

## How It Works: Full Flow

```
1. MERCHANT creates a checkout session via API or dashboard
   POST /api/sessions --> { facadeAddress, sessionId, checkoutURL }

2. SERVER generates a fresh Solana keypair (the "facade")
   createFacade() --> ephemeral keypair stored server-side only

3. BUYER pays the facade address (standard SPL USDC transfer)
   Normal on-chain transaction. Facade address is publicly visible.

4. SERVER detects payment via balance polling
   GET /api/sessions/:id/balance --> checks facade ATA balance

5. SERVER triggers private settlement via MagicBlock
   POST https://payments.magicblock.app/v1/spl/transfer
   { from: facade, to: vaultATA, visibility: "private", gasless: true }

6. MAGICBLOCK returns a partially-signed VersionedTransaction
   Crank keypair (CrankS2f...) pre-signs. Server adds facade signature.
   vtx.addSignature(facadePubkey, nacl.sign.detached(msg, facadeSecretKey))
   Preserves crank signature. Avoids double-sign wipe.

7. SERVER submits the versioned transaction
   Funds route through MagicBlock's ER network --> vault receives net USDC
   No direct facade-to-vault link exists on-chain

8. SESSION marked settled. Facade keypair discarded.
```

---

## Technical Notes for Judges

**Fee handling:** MagicBlock charges approximately 0.2 USDC flat on top of the transfer amount in `gasless: true` mode. BlackRail uses a two-call approach: first call to get the fee, subtract from amount, second call with the adjusted amount so the facade balance covers both. Non-obvious integration detail that took iteration to solve.

**Signature preservation:** `VersionedTransaction.sign([facade])` wipes existing signatures, including MagicBlock's crank pre-signature. We use `vtx.addSignature()` directly with `nacl.sign.detached()` to inject the facade signature without disturbing the crank's. Critical for the transaction to be valid.

**Gasless minimum:** `gasless: true` requires a minimum of 0.5 USDC. Payments below this threshold fall back to standard SPL (not private). Surfaced in the UI.

**Atomic settlement guard:** Session status is updated with `WHERE status = 'active'` in the same SQL statement that triggers settlement, preventing duplicate settle attempts under concurrent poll hits.

**DB:** Neon Postgres via Drizzle ORM. Schema: `sessions` (facade keypair, status, amount, expiry) and `payments` (settled records).

### Why the Hosted Payments API, Not Raw SDK Delegation

BlackRail integrates MagicBlock's Private Payments API rather than implementing
ER delegation directly against the SDK. This was a deliberate choice: the privacy
primitive (unlinkable facade → vault settlement via a Private Ephemeral Rollup)
is a solved problem at that layer. Re deriving PER delegation at the SDK level
would have meant spending hackathon build time re implementing a primitive
MagicBlock already ships which blackrail is 100% impossible without, instead of
building the merchant facing product this submission is actually about: the
checkout session model, disposable facade flow, merchant dashboard and privacy
layer for businesses against competitors.

### Confirmed Directly by MagicBlock

To confirm the transfer genuinely executes inside the PER (rather than the
`visibility: private` flag being cosmetic for `base→base` transfers), we asked
directly in MagicBlock's public builder Telegram group and confirmed:

> "The transfer goes through the PER to break the link sender/destination,
> additionally it perform the splits and delay (based on the transfer config)."

This confirms the unlinkability guarantee and the split/delay capability
described above is enforced inside the PER itself, not just claimed at the
API surface.
---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Static HTML/CSS/JS on Netlify |
| API | Express + TypeScript on Railway |
| Database | Neon Postgres (Drizzle ORM) |
| Auth | Privy (Google, X, email OTP) |
| Blockchain | Solana devnet, `@solana/web3.js` |
| Privacy layer | **MagicBlock Payments API: Private ER routing** |

---

## API Reference

```
POST   /api/sessions                  Create checkout session
GET    /api/sessions/:id              Get session state
GET    /api/sessions/:id/balance      Check facade on-chain balance
POST   /api/sessions/:id/settle       Trigger private MB settlement
GET    /api/payments                  Payment history
GET    /api/vault/balance             Vault USDC balance
POST   /api/vault/withdraw            Withdraw to any address
```

---

## The Revolution

I built BlackRail to remove the abstraction friction that is quietly killing Web3 adoption at the retail level.

Here is the honest problem nobody talks about enough: the trust layer is already broken.

I remember trying to purchase a name service on a platform similar to ENS. I could not understand why I had to sign a transaction in my wallet to complete what felt like a simple purchase. ENS is globally recognised. The platform was legitimate. But the moment a wallet signature prompt appeared, I froze. Not because I lacked technical knowledge, but because the experience itself was fundamentally unsafe by design.

Wallet signatures are the single largest attack surface in all of Web3. They are the reason hacks happen. They are the reason drains happen. I am a victim myself. The pattern is identical every time: a platform that requires some form of payment or approval, a signature prompt, and a message underneath that 65% of users in documented cases do not read, and 45% do not understand even when they try.

The signature is asking you to trust a contract you cannot audit, on a platform you found an hour ago, with money you cannot get back.

BlackRail removes this entirely.

With BlackRail, you do not sign anything. You do not connect your wallet. You do not approve a contract. You receive an address, you send to it from any wallet using the method you already know, and the gateway handles everything else. Verification, settlement, confirmation. It works exactly like the Web2 payment flow that billions of people already trust: you send to a gateway, it checks and verifies, you get your product.

This is not a compromise. It is the correct architecture for onboarding the next wave of retail users.

The people who will push Web3 to a billion users are not DeFi natives. They are everyday people who have never touched a hardware wallet, who send money through Paystack and PayPal, who buy airtime and pay rent on mobile apps. For them, a wallet signature prompt is not a speed bump. It is a full stop.

BlackRail builds the payment layer those users can actually use. Private by architecture. Familiar by design. No signatures. No wallet connections. No trust assumptions.

The ecosystem does not need more tools for the people already inside it. It needs friendlier infrastructure for the people still outside.

---

## Hackathon Track

**MagicBlock Blitz: Ephemeral Rollups / Private ERs**

BlackRail demonstrates a real-world payment primitive built entirely on MagicBlock's private ER infrastructure. The use case is immediately legible to non-crypto users, the integration is non-trivial (fee handling, signature preservation, atomic guards), and the product is fully live end-to-end on Solana devnet.

The market it targets already processes hundreds of billions of dollars annually through centralized processors. The privacy problem it solves is real, documented, and affects every merchant, freelancer, and individual who receives money. BlackRail is the first working implementation of that solution using Ephemeral Rollups.

---

## Vault

- Vault owner: `2QGJqSPWogpnrsrEagH4Mn28JjvuxMjrNMPbUst56j6Y`
- Vault USDC ATA: `B82AzAWZsvVUwW1iddK8H45E1rj6QKS36X9FPFtHmbjM` (the vault owner's USDC token account)
- Network: Solana devnet

## Trust Model (Current → Next)

**Today (devnet, demo-scale):** Single-key custodial vault. The server holds one `SERVER_KEYPAIR` that controls settlement. This is intentional for rapid iteration — every settlement path is auditable in `solana.ts`.

**Next (mainnet):** Program-enforced multisig/threshold vault. The on-chain program will enforce settlement rules (minimum amounts, time locks, authorized signers) so no single key can sweep funds unilaterally. This is the critical trust-minimization step before handling real volume.

---

*Built for MagicBlock Founders Camp 2026.*
