# Finance architecture — 20% commission + tax compliance

Source of truth: **Order financial snapshot → Ledger lines**. Browser never sends commission/tax/payout amounts.

## 1. Impact analysis

Current checkout (`src/routes/billing.js`) calls `splitRevenue(gross)` in `src/utils/platform.js`:

```text
platformFee = gross × 0.20
sellerNet   = gross − platformFee   // i.e. gross × 0.80
```

That formula is **platform commission only**. It must not be treated as tax, and it must not be the sole seller payable. Usage routes (playground, edge, gateway, compute, agents, deployments) repeat the same 20/80 split and **ignore `PLATFORM_DIRECT`**, so platform-owned usage was incorrectly paying 80% to the catalog creator.

WalletTx remains an **internal entitlement movement** for buyer debit / seller credit (not a licensed e-wallet). Seller “balance” is derived, not a bank account. Reporting must use ledger + order snapshots.

## 2. Existing models to change

| Model | Change |
|---|---|
| `Order` | Snapshot: commissionRate/Amount, taxAmount/Breakdown, paymentFee, sellerGross/Net, platformRevenue. Keep `amount`, `platformFee`, `sellerNet` for API compatibility. |
| `Product` | Optional `taxCategory`. |
| `SellerProfile` | Canonical seller types (keep legacy lowercase). |
| `LedgerEntry.type` | Add PLATFORM_REVENUE, SELLER_PAYABLE, TAX_PAYABLE, PAYMENT_PROCESSING_FEE, CHARGEBACK, CUSTOMER_PAYMENT. Keep old enums. |
| `LegalDocument` | Add `tax-policy`, `invoice-policy`. |

## 3. Existing APIs to change (compatible)

| API | Change |
|---|---|
| `POST /v1/billing/checkout` | Backend settlement only; ignore client money fields. |
| `GET /v1/admin/overview` | Sum **snapshots**, do not recompute GMV × 20%. |
| `GET /v1/dashboard/summary` | Return fee / tax / net breakdown. |
| Usage charge paths | Use settlement engine; PLATFORM_DIRECT → no seller payable. |
| `POST /v1/wallet/withdraw` | Route through payout eligibility (verified / not suspended). |

Checkout body remains `{ productId, quantity }` only.

## 4. New models

`CommissionRule`, `SellerTaxProfile`, `TaxRule`, `TaxTransaction`, `TaxWithholding`, `SellerPayout`, `Refund`, `Chargeback`, `PaymentEvent` (idempotency), `Invoice` / `InvoiceItem`.

## 5. New services (`src/finance/`)

CommissionEngine, TaxEngine, PaymentFeeEngine, SettlementEngine, LedgerService, RefundService, ChargebackService, PayoutEngine, InvoiceService, ReconciliationService, PaymentProvider (internal ledger first).

## 6. Migration

- Default `CommissionRule` 20% for `THIRD_PARTY_SELLER` (seeded, not hardcoded in controllers).
- Historical orders: keep stored `platformFee`/`sellerNet`. `commissionAmount` falls back to `platformFee` when ownership is third-party.
- No rewrite of old ledger rows. New types used going forward; old `PLATFORM_FEE` / `SELLER_ENTITLEMENT` still valid.
- Tax: **no statutory rate in code**. Matching ACTIVE `TaxRule` only; otherwise tax = 0 until compliance configures rules.

## 7. Test strategy

Node built-in test runner (`npm test`), no Mongo required for engines:

1. Individual seller + 20% commission + TaxEngine rule  
2. Company seller different tax rule  
3. PLATFORM_DIRECT — no seller payable, full platform revenue  
4. Refund reverses commission/tax/payable  
5. Chargeback adjustment (does not mutate original)  
6. Duplicate payment event id → no double post  
7. Commission rule change does not alter prior snapshot  
8. Tax rule change does not alter prior snapshot  
9. Suspended seller → payout ON_HOLD  
10. Foreign seller does not match VN-only tax rule  

## Money flow (third-party)

```text
Customer pays listed price (commission is seller-borne by default)
  CUSTOMER_PAYMENT     +gross
  PLATFORM_REVENUE     +commission (default 20%)
  TAX_PAYABLE          +withholding (if TaxEngine rule matches)
  STORE_FEE            −Play 15% / App Store 30% (IAP only; paid to Google/Apple, not platform)
  PAYMENT_PROCESSING_FEE ±fee (if configured)
  SELLER_PAYABLE       +gross − commission − store fee − tax − seller-borne fee − refund − chargeback
```

Web/wallet checkout: store fee = 0. In-app purchase `salesChannel=GOOGLE_PLAY` (CHPlay) or `APP_STORE` applies the store snapshot. Store fees are **not** platform commission and **not** tax.

Platform-owned: commission rate snapshot **0**, `sellerNet = 0`, `platformRevenue = gross − storeFee`.
