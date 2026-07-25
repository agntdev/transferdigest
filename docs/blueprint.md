# Transfer Tracker Bot — Bot specification

**Archetype:** custom

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

A Telegram bot that aggregates professional football club transfers worldwide and delivers a daily private summary to the owner at 08:00 local time. Each transfer includes player details, clubs involved, fee, contract terms, and source links. On-demand commands allow filtering by date, confirming subscriptions, and viewing full transfer details.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- football transfer enthusiasts
- sports analysts
- club administrators

## Success criteria

- Daily 08:00 summary message with all new transfers since last check
- On-demand /today and /since commands return accurate filtered results
- All transfers are deduplicated by player+from+to+timestamp

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with available commands
- **/today** (command, actor: user, command: /today) — Request immediate summary of today's transfers
- **/subscribe** (command, actor: user, command: /subscribe) — Confirm notification subscription status
- **/unsubscribe** (command, actor: user, command: /unsubscribe) — Disable daily notifications
- **/detail** (command, actor: user, command: /detail) — View full transfer details by ID
- **Details** (button, actor: user, callback: transfer:detail) — Request full details for a specific transfer in summary view
- **Source** (button, actor: user, callback: transfer:source) — Open authoritative source link for a transfer
- **Mark as read** (button, actor: user, callback: transfer:mark_read) — Acknowledge having seen a specific transfer

## Flows

### daily_summary
_Trigger:_ scheduled 08:00 owner timezone

1. Check for new transfers since last summary
2. Group transfers by league/country
3. Paginate if >15 transfers
4. Send message with summary list and inline buttons

_Data touched:_ Transfer, UserPreference

### on_demand_summary
_Trigger:_ /today

1. Fetch transfers from current day
2. Format as condensed list with pagination

_Data touched:_ Transfer

### date_range_summary
_Trigger:_ /since YYYY-MM-DD

1. Validate date format
2. Fetch transfers since specified date
3. Send grouped/paginated results

_Data touched:_ Transfer

### transfer_detail
_Trigger:_ transfer:detail callback

1. Fetch full transfer record by ID
2. Display all fields including medical/fitness notes

_Data touched:_ Transfer

### subscription_control
_Trigger:_ /subscribe or /unsubscribe

1. Update notification status in UserPreference
2. Confirm change with owner

_Data touched:_ UserPreference

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Transfer** _(retention: persistent)_ — Football transfer record with deduplication fields
  - fields: player, age, from_club, to_club, transfer_fee, currency, transfer_type, contract_length, salary, medical_notes, agent, timestamp, source_links
- **UserPreference** _(retention: persistent)_ — Owner's notification settings
  - fields: admin_chat_id, timezone, summary_time, notification_enabled

## Integrations

- **Telegram** (required) — Bot API messaging and scheduled notifications
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Set daily summary time
- Enable/disable notifications
- View full transfer details

## Notifications

- Daily 08:00 transfer summary with rich formatting and source links

## Permissions & privacy

- Store transfer records securely with deduplication logic
- Only send messages to verified owner account
- Never share personal data with third parties

## Edge cases

- No transfers in time window shows 'No activity' message
- Multiple sources for same transfer shows all links
- Invalid date format in /since shows error and retry prompt

## Required tests

- End-to-end daily summary flow with pagination
- Deduplication validation across multiple sources
- Timezone-aware scheduling test
- Command parameter validation for /since

## Assumptions

- Owner will provide at least one source API integration
- Transfer fee currency conversion is not required
- Medical/salary data will be sparse and marked as 'Not reported' when missing
