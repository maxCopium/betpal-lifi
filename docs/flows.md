# BetPal — Flow Diagrams

## 1. Group Creation

```mermaid
sequenceDiagram
    actor U as User
    participant UI as NewGroupForm
    participant API as POST /api/groups
    participant Privy as Privy Wallet API
    participant DB as Supabase

    U->>UI: Enter name, pick vault, add friends
    UI->>API: { name, memberIds, vaultAddress, vaultChainId }
    API->>DB: INSERT groups (status=pending)
    API->>Privy: createWallet(groupId)
    Privy-->>API: wallet_address, privy_wallet_id
    API->>DB: UPDATE groups (wallet_address)
    API->>DB: INSERT group_members (owner + members)
    API-->>UI: { groupId, wallet_address }
    UI->>U: Redirect to group dashboard
```

## 2. Deposit (3-Phase)

```mermaid
sequenceDiagram
    actor U as User
    participant UI as BetDetail / DepositFlow
    participant API1 as POST /deposits
    participant LIFI as LI.FI Composer
    participant API2 as POST /deposits/confirm
    participant DB as Supabase
    participant Vault as ERC-4626 Vault

    Note over U,Vault: Phase 1 — Quote
    U->>UI: Choose source chain/token, amount
    UI->>API1: { fromChain, fromToken, amountUsd, betId?, outcome? }
    API1->>LIFI: getComposerQuote(from → vault on Base)
    LIFI-->>API1: quote + transactionRequest
    API1->>DB: INSERT transactions (status=pending)
    API1-->>UI: { depositId, quote }

    Note over U,Vault: Phase 2 — Sign & Broadcast
    U->>UI: Approve & sign tx
    UI->>Vault: eth_sendTransaction (user-signed via Privy)
    Vault-->>UI: txHash

    Note over U,Vault: Phase 3 — Confirm & Credit
    U->>UI: Click "Confirm"
    UI->>API2: { depositId, txHash }
    API2->>LIFI: getComposerStatus(txHash)
    LIFI-->>API2: DONE
    API2->>DB: addBalanceEvent(+amount, reason=deposit)
    API2->>DB: UPDATE groups status → active
    opt Auto-stake on target bet
        API2->>DB: INSERT stakes
        API2->>DB: addBalanceEvent(-stake, reason=stake_lock)
    end
    API2->>DB: UPDATE transactions (status=completed)
    API2-->>UI: { status, stake_status }
```

## 3. Bet Creation

```mermaid
sequenceDiagram
    actor U as User
    participant UI as NewBetDialog
    participant API as POST /api/groups/[id]/bets
    participant Poly as Polymarket (Gamma)
    participant DB as Supabase

    U->>UI: Search markets, pick one
    U->>UI: Set deadline, stake, max participants
    UI->>API: { polymarket_market_id, stake_amount_cents, join_deadline, ... }
    API->>Poly: getMarket(market_id)
    Poly-->>API: question, outcomes, endDate
    API->>DB: INSERT bets (status=open)
    API-->>UI: { betId }
    UI->>U: Redirect to bet detail
```

## 4. Placing a Bet (Staking)

```mermaid
flowchart TD
    A[User clicks Bet on outcome] --> B{Free balance >= stake?}
    B -- Yes --> C[POST /api/bets/id/stake]
    B -- No --> D[Deposit flow with auto-stake]
    
    C --> E[Validate: open, deadline, max participants]
    E --> F[INSERT stakes]
    F --> G[addBalanceEvent -stake_lock]
    G --> H{start_when_full && count >= max?}
    H -- Yes --> I[Auto-lock bet status=locked]
    H -- No --> J[Done]
    I --> J

    D --> K[Phase 1-3 Deposit]
    K --> L[Confirm auto-stakes on completion]
    L --> J
```

## 5. Bet Resolution

```mermaid
flowchart TD
    A[Trigger: lazy GET / manual POST / daily cron] --> B[resolveBetIfPossible]
    B --> C{< 2 stakers OR all same side?}
    C -- Yes --> D[VOID: refund all stakes]
    C -- No --> E[Check Polymarket oracle]
    E --> F{Market settleable?}
    F -- No --> G[Set status=resolving, wait]
    F -- Yes --> H[Compute pari-mutuel payouts]
    H --> I[Credit winners via ledger]
    I --> J[Distribute yield pro-rata]
    J --> K[Auto-payout: vault.redeem + USDC.transfer]
    K --> L[Set status=settled]
    D --> M[Set status=voided]

    style D fill:#faa
    style L fill:#afa
    style M fill:#faa
```

## 6. Force Resolve (Unanimous Consent)

```mermaid
sequenceDiagram
    actor A as Staker A
    actor B as Staker B
    participant API as /api/bets/[id]/force-resolve
    participant DB as Supabase

    A->>API: POST { outcome: "Yes" }
    API->>DB: Set force_resolve_outcome, auto-vote for A
    API-->>A: { votes: 1, total: 2 }

    B->>API: POST { accept: true }
    API->>DB: Insert vote for B
    API->>API: votes == stakers → unanimous!
    API->>DB: Set mock_resolved_outcome
    API->>API: resolveBetIfPossible() → full payout flow
    API-->>B: { unanimous: true, resolved: true }
```

## 7. Cancel Vote (Unanimous Refund)

```mermaid
sequenceDiagram
    actor A as Staker A
    actor B as Staker B
    participant API as /api/bets/[id]/cancel-vote
    participant DB as Supabase

    A->>API: POST (vote to cancel)
    API->>DB: INSERT cancel_vote for A
    API-->>A: { votes: 1, total: 2, unanimous: false }

    B->>API: POST (vote to cancel)
    API->>DB: INSERT cancel_vote for B
    Note over API: All stakers voted → void bet
    API->>DB: addBalanceEvent(+stake) for each staker
    API->>DB: UPDATE bet status=voided
    API-->>B: { unanimous: true, voided: true }
```

## 8. Withdrawal

```mermaid
sequenceDiagram
    actor U as User
    participant UI as WithdrawForm
    participant API as POST /api/groups/[id]/withdrawals
    participant DB as Supabase
    participant Vault as ERC-4626 Vault
    participant USDC as USDC Contract

    U->>UI: Enter amount, click Withdraw
    UI->>API: { amountCents }
    API->>DB: Check free balance >= amount
    API->>DB: addBalanceEvent(-amount, withdrawal_reserve)
    API->>DB: INSERT transactions (type=withdrawal, status=executing)
    API->>Vault: vault.redeem(shares) → USDC to group wallet
    API->>USDC: transfer(userWallet, amount)
    alt Both succeed
        API->>DB: UPDATE tx status=completed
        API-->>UI: { txHash, status: completed }
    else Transfer fails after redeem
        API->>DB: UPDATE tx status=partial
        API-->>UI: 502 (USDC in group wallet, manual recovery)
    else Full failure
        API->>DB: addBalanceEvent(+amount, withdrawal_reverse)
        API->>DB: UPDATE tx status=failed
        API-->>UI: Error
    end
```

## 9. Vault Switching (4-Eye Approval)

```mermaid
sequenceDiagram
    actor A as Member A
    actor B as Member B
    participant API as /api/groups/[id]/vault-switch
    participant DB as Supabase
    participant Old as Old Vault
    participant New as New Vault

    A->>API: POST { newVaultAddress }
    API->>DB: Set pending_vault_address, proposed_by=A
    API-->>A: { status: proposed }

    B->>API: POST /accept (B ≠ A)
    API->>Old: vault.redeem(allShares) → USDC to group wallet
    API->>New: USDC.approve(newVault)
    API->>New: newVault.deposit(balance) → shares to group wallet
    alt Deposit succeeds
        API->>DB: UPDATE vault_address=new, clear pending
        API-->>B: { status: accepted, migrated_cents }
    else Deposit fails
        API->>Old: Re-deposit USDC to old vault
        API->>DB: Clear pending (vault unchanged)
        API-->>B: { status: failed, rolled back }
    end
```

## 10. Invite Flow

```mermaid
sequenceDiagram
    actor Owner as Group Member
    actor New as New User
    participant API1 as POST /api/groups/[id]/invites
    participant API2 as POST /api/invites/[token]/accept
    participant DB as Supabase

    Owner->>API1: Create invite
    API1->>DB: INSERT invite_links (token, expires 7d)
    API1-->>Owner: { token, link }
    Owner->>New: Share link

    New->>API2: Accept invite (must be signed in)
    API2->>DB: Validate token (exists, unused, not expired)
    API2->>DB: UPDATE invite_links (used_at, used_by)
    API2->>DB: INSERT group_members (role=member)
    API2-->>New: { group_id }
```

## 11. Overall System Architecture

```mermaid
flowchart LR
    subgraph Frontend
        A[React App<br/>Win98 UI]
    end

    subgraph Backend["Next.js API Routes"]
        B[Auth<br/>Privy]
        C[Ledger<br/>balance_events]
        D[Bets/Stakes]
        E[Resolution]
        F[Deposits/Withdrawals]
    end

    subgraph External
        G[Polymarket<br/>Oracle]
        H[LI.FI Composer<br/>Cross-chain deposits]
        I[LI.FI Earn<br/>Vault discovery]
    end

    subgraph Onchain["Base L2"]
        J[ERC-4626 Vault<br/>Morpho/etc]
        K[USDC]
        L[Group Wallet<br/>Privy custodial]
    end

    subgraph Storage
        M[(Supabase<br/>Postgres)]
    end

    A --> B
    A --> D
    A --> F
    B --> M
    C --> M
    D --> M
    E --> G
    E --> J
    F --> H
    F --> J
    F --> K
    I --> J
    L --> J
    L --> K
```
