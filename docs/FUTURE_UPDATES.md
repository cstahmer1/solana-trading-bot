# Future Updates

This document tracks planned enhancements and feature requests for the trading bot.

---

## Signal History Chart - User-Selectable Token Tracking

**Priority:** Medium  
**Status:** Planned  
**Added:** 2025-12-27

### Current Behavior
- The Signal History chart displays only the first 6 tokens from the `byToken` array
- This limit exists for chart readability (23+ lines would be cluttered)
- Users cannot select which tokens appear in the chart

### Proposed Enhancement
Allow users to select on-the-fly which live signals they want to track in the Signal History chart.

### Requirements
1. **Flexible Selection UI**
   - Dropdown or multi-select component in the Signals tab
   - Show all available tokens from Live Signals list
   - Allow selecting/deselecting individual tokens for chart tracking

2. **Default Behavior**
   - System should have sensible defaults (e.g., top 6 by score, or tokens in trading_universe)
   - New users see a functional chart immediately without configuration

3. **Persistence**
   - User selections must persist after bot restart
   - Store preferences in database (new table or bot_settings)
   - Schema suggestion:
     ```sql
     CREATE TABLE user_signal_preferences (
       id SERIAL PRIMARY KEY,
       user_id TEXT DEFAULT 'default',
       selected_mints TEXT[], -- Array of mint addresses
       created_at TIMESTAMP DEFAULT NOW(),
       updated_at TIMESTAMP DEFAULT NOW()
     );
     ```

4. **Implementation Notes**
   - Update `/api/signals/history` to accept optional `mints` query parameter
   - Modify `renderSignalChart()` to filter by user preferences
   - Add UI controls for selection with "Save" and "Reset to Defaults" buttons
   - Consider max selection limit (e.g., 10-12) for chart performance

### Related Files
- `src/dashboard/server.ts` - Line 2290 has the `.slice(0, 6)` limit
- `src/bot/telemetry.ts` - `getAllSignalHistory()` and `signalHistory` Map

---
