# Marketplace Core — Legal-first notes

See also: `../AI_Marketplace_Frontend_Prompt.md` and `../denglish-api/ARCHITECTURE.md`.

## Entity split

| Concept | Implementation |
|---------|----------------|
| **Seller** | `SellerProfile` + User (`creator` role for shop tooling) |
| **Provider** | `Product.infraProvider` / denglish-api adapters — never auto-seller |
| **Platform Direct** | `ownershipType: PLATFORM_DIRECT` |
| **Third-party** | `ownershipType: THIRD_PARTY_SELLER` + verified SellerProfile |

## Key APIs

- `GET/POST /v1/sellers/*` — apply, accept agreement, admin status
- `GET/POST /v1/legal/*` — versioned legal documents + acceptances
- Checkout writes `contractSnapshot` + `financial_ledger` entries. **Platform commission default 20%** is stored as an order snapshot (`commissionRate` / `commissionAmount`) and is **not seller tax**. See `FINANCE_ARCHITECTURE.md`.

## Finance framing

Wallet balances are **internal ledger entitlements** for reconciliation, not a licensed e-wallet product. Prefer licensed payment gateways for customer collection when available.
