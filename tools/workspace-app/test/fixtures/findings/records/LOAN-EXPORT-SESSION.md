# Loan export reads the member from the session (X1, H23)

Status: Done
Date: 2026-01-12

## Problem
The loan export trusted the member id from the query string.

## Change
The export now reads the member from the session. Q-H2 is mentioned here, in the second
section, so it must not count as fixed by this record.
