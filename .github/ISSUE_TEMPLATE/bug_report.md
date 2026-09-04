---
name: "🐛 Bug Report"
about: Report a defect, concurrency race condition, or allocation issue
title: "[BUG]: "
labels: ["bug", "triage"]
assignees: ""
---

### 🐛 Bug Description
<!-- Clear and concise description of the bug -->

### 🔁 Reproduction Steps
1. Navigate to '...'
2. Submit payload / trigger action:
   ```json
   { "request_id": "REQ-101", "emergency_type": "CARDIAC" }
   ```
3. Observe incorrect state or error.

### 💥 Expected Behavior vs Actual Behavior
- **Expected:** 
- **Actual:** 

### 📊 Log / Transaction Trace
```log
<!-- Paste error logs, stack trace, or database deadlock messages -->
```

### 💻 Environment & Severity
- Environment: [e.g. Node 20.x, MySQL 8.0, macOS]
- Severity: [Critical (Double Allocation / Data Loss) / High / Medium / Low]
