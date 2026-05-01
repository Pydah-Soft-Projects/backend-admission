# User Performance Migration Plan

## 1. Problem Statement
The current User Performance and Call Reports dashboard scans millions of rows in `activity_logs` and `communications` in real-time. This causes significant latency and timeouts (502 errors) in the hosted environment, even though it performs adequately on local development machines with small datasets.

## 2. Proposed Solution: Aggregate Table
We will transition to a **Summary Table** architecture. Instead of scanning raw logs on every page load, we will store pre-calculated daily metrics in a new table: `user_performance_summaries`.

## 3. Data Schema: `user_performance_summaries`
| Column | Type | Description |
| :--- | :--- | :--- |
| `user_id` | `CHAR(36)` | The UUID of the user. |
| `academic_year` | `INT` | The year filter. |
| `student_group` | `VARCHAR(50)` | The group filter (10th, Inter, etc.). |
| `summary_date` | `DATE` | The specific day this data represents. |
| `role_name` | `VARCHAR(50)` | Snapshot of the user's role (Counselor/PRO). |
| `total_handled_leads` | `INT` | Unique leads touched by the user today. |
| `active_leads_count`| `INT` | Snapshot of current assigned leads (non-terminal). |
| `converted_count` | `INT` | Leads converted to admissions today. |
| `reclaimed_count` | `INT` | Leads taken FROM this user by the reclaimer today. |
| `calls_count` | `INT` | Total calls made today. |
| `sms_count` | `INT` | Total SMS sent today. |
| `status_breakdown` | `JSON` | JSON object of status counts (call_status or visit_status). |

## 4. Business Logic Handling

### A. Role-Based Statuses
*   **Counselors**: The `status_breakdown` will aggregate counts from `call_status`.
*   **PROs**: The `status_breakdown` will aggregate counts from `visit_status`.
*   This ensures that the "Interested" or "Confirmed" labels match the specific workflow of the user.

### B. Reclamations
*   We will hook into the `LeadReclaimer` service. 
*   When a lead is reclaimed, the system identifies the `previousAssignee` from the activity log metadata and increments their `reclaimed_count` for the current date.

### C. Conversions
*   When an admission is created, the system identifies the assigned Counselor/PRO and increments their `converted_count`.

## 5. Implementation Phases

### Phase 1: Infrastructure
*   Create the `user_performance_summaries` table.
*   Implement a background "Hydrator" script to populate the table with historical data (scanning existing logs once to seed the table).

### Phase 2: Real-time Data Pipeline (COMPLETED)
- [x] Create `userPerformance.service.js` for atomic metric updates.
- [x] Integrate hooks into:
    - `communication.controller.js` (Calls, SMS)
    - `leadStatus.controller.js` (Status changes, Handled leads)
    - `joining.controller.js` (Admissions/Conversions)
    - `leadReclaimer.service.js` (Reclaimed counts)

### Phase 3: API Transition (COMPLETED)
- [x] Refactor `getUserAnalytics` in `leadAssignment.controller.js`.
- [x] Implement logic to aggregate daily metrics from `user_performance_summaries`.
- [x] Maintain backward compatibility for roster-only and snapshot modes.

### Phase 4: Verification & Cleanup (PENDING)
- [ ] Run historical hydration script.
- [ ] Compare summary table totals with raw log counts.
- [ ] (Optional) Archive old activity logs if storage is an issue (only after verification).

## 6. Expected Impact
*   **Latency**: API response time reduced from seconds/minutes to milliseconds.
*   **Stability**: Elimination of 502/Gateway Timeout errors on the hosted version.
*   **Scalability**: The system will handle millions of leads without slowing down the dashboard.
