use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};
use ephemeral_rollups_sdk::anchor::{delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("D6au34Ft153B5ghrujVzTg4nGJFiitpePnoQ666JPzB7");

const SETTLEMENT_SEED: &[u8] = b"settlement";

#[ephemeral]
#[program]
pub mod mirage_vault {
    use super::*;

    pub fn initialize_intent(
        ctx: Context<InitializeIntent>,
        session_id: [u8; 32],
        required_amount: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(required_amount > 0, MirageError::ZeroAmount);
        require!(expires_at > Clock::get()?.unix_timestamp, MirageError::InvalidExpiry);

        let intent = &mut ctx.accounts.intent;
        intent.session_id = session_id;
        intent.operator = ctx.accounts.operator.key();
        intent.facade = ctx.accounts.facade.key();
        intent.merchant = ctx.accounts.merchant.key();
        intent.mint = ctx.accounts.mint.key();
        intent.required_amount = required_amount;
        intent.observed_amount = 0;
        intent.expires_at = expires_at;
        intent.released_at = 0;
        intent.bump = ctx.bumps.intent;
        intent.released = false;
        intent.settled = false;
        Ok(())
    }

    pub fn delegate_intent(ctx: Context<DelegateIntent>, session_id: [u8; 32]) -> Result<()> {
        let seeds: &[&[u8]] = &[SETTLEMENT_SEED, session_id.as_ref()];
        ctx.accounts.delegate_intent(
            &ctx.accounts.operator,
            seeds,
            DelegateConfig {
                commit_frequency_ms: u32::MAX,
                validator: None,
            },
        )?;
        Ok(())
    }

    pub fn authorize_release(
        ctx: Context<AuthorizeRelease>,
        _session_id: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let intent = &mut ctx.accounts.intent;
        let observed_amount = ctx.accounts.facade_ata.amount;

        require!(!intent.released, MirageError::AlreadyReleased);
        require!(!intent.settled, MirageError::AlreadySettled);
        require!(now <= intent.expires_at, MirageError::IntentExpired);
        require!(observed_amount >= intent.required_amount, MirageError::InsufficientPayment);

        intent.observed_amount = observed_amount;
        intent.released_at = now;
        intent.released = true;

        commit_and_undelegate_accounts(
            &ctx.accounts.operator.to_account_info(),
            vec![&ctx.accounts.intent.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program.to_account_info(),
            None,
        )?;
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, _session_id: [u8; 32]) -> Result<()> {
        let intent = &mut ctx.accounts.intent;
        let amount = ctx.accounts.facade_ata.amount;

        require!(intent.released, MirageError::ReleaseNotAuthorized);
        require!(!intent.settled, MirageError::AlreadySettled);
        require!(amount >= intent.required_amount, MirageError::InsufficientPayment);
        require!(amount >= intent.observed_amount, MirageError::BalanceChanged);

        intent.settled = true;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.facade_ata.to_account_info(),
                    to: ctx.accounts.merchant_ata.to_account_info(),
                    authority: ctx.accounts.facade.to_account_info(),
                },
            ),
            amount,
        )?;
        token::close_account(CpiContext::new(
            ctx.accounts.token_program.key(),
            CloseAccount {
                account: ctx.accounts.facade_ata.to_account_info(),
                destination: ctx.accounts.operator.to_account_info(),
                authority: ctx.accounts.facade.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(session_id: [u8; 32])]
pub struct InitializeIntent<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    /// CHECK: Stored as the required facade token authority.
    pub facade: UncheckedAccount<'info>,
    /// CHECK: Stored as the required destination token owner.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: Stored and checked against both token accounts at settlement.
    pub mint: UncheckedAccount<'info>,
    #[account(
        init,
        payer = operator,
        space = 8 + SettlementIntent::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, session_id.as_ref()],
        bump,
    )]
    pub intent: Account<'info, SettlementIntent>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(session_id: [u8; 32])]
pub struct DelegateIntent<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(
        mut,
        del,
        seeds = [SETTLEMENT_SEED, session_id.as_ref()],
        bump = intent.bump,
        has_one = operator @ MirageError::WrongOperator,
    )]
    pub intent: Account<'info, SettlementIntent>,
}

#[derive(Accounts)]
#[instruction(session_id: [u8; 32])]
pub struct AuthorizeRelease<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    /// CHECK: The facade authority is bound to the intent and only used to
    /// validate ownership of the observed token account.
    pub facade: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [SETTLEMENT_SEED, session_id.as_ref()],
        bump = intent.bump,
        has_one = operator @ MirageError::WrongOperator,
    )]
    pub intent: Account<'info, SettlementIntent>,
    #[account(
        constraint = facade.key() == intent.facade @ MirageError::WrongFacade,
        constraint = facade_ata.owner == facade.key() @ MirageError::WrongFacade,
        constraint = facade_ata.mint == intent.mint @ MirageError::WrongMint,
    )]
    pub facade_ata: Account<'info, TokenAccount>,
    #[account(mut, address = ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID)]
    /// CHECK: Canonical MagicBlock context account.
    pub magic_context: UncheckedAccount<'info>,
    pub magic_program: Program<'info, MagicProgram>,
}

#[derive(Accounts)]
#[instruction(session_id: [u8; 32])]
pub struct Settle<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    pub facade: Signer<'info>,
    #[account(
        mut,
        close = operator,
        seeds = [SETTLEMENT_SEED, session_id.as_ref()],
        bump = intent.bump,
        has_one = operator @ MirageError::WrongOperator,
        has_one = facade @ MirageError::WrongFacade,
    )]
    pub intent: Account<'info, SettlementIntent>,
    #[account(
        mut,
        constraint = facade_ata.owner == facade.key() @ MirageError::WrongFacade,
        constraint = facade_ata.mint == intent.mint @ MirageError::WrongMint,
    )]
    pub facade_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = merchant_ata.owner == intent.merchant @ MirageError::WrongMerchant,
        constraint = merchant_ata.mint == intent.mint @ MirageError::WrongMint,
    )]
    pub merchant_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct SettlementIntent {
    pub session_id: [u8; 32],
    pub operator: Pubkey,
    pub facade: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub required_amount: u64,
    pub observed_amount: u64,
    pub expires_at: i64,
    pub released_at: i64,
    pub bump: u8,
    pub released: bool,
    pub settled: bool,
}

#[error_code]
pub enum MirageError {
    #[msg("amount must be greater than zero")]
    ZeroAmount,
    #[msg("expiry must be in the future")]
    InvalidExpiry,
    #[msg("settlement intent has expired")]
    IntentExpired,
    #[msg("observed payment is below the required amount")]
    InsufficientPayment,
    #[msg("release was already authorized")]
    AlreadyReleased,
    #[msg("settlement was already completed")]
    AlreadySettled,
    #[msg("release has not been authorized on the rollup")]
    ReleaseNotAuthorized,
    #[msg("facade balance changed after release authorization")]
    BalanceChanged,
    #[msg("wrong settlement operator")]
    WrongOperator,
    #[msg("wrong facade authority")]
    WrongFacade,
    #[msg("wrong merchant destination")]
    WrongMerchant,
    #[msg("wrong token mint")]
    WrongMint,
}
