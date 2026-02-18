# RFD-42: Add client-side RFDB version validation on connect

## Problem

When Grafema connects to RFDB server, no version compatibility check is performed. The ping response includes `version` but it's never validated against what the client expects. Old binaries can silently serve requests with potentially incompatible protocol behavior.

## Desired outcome

* After connecting, client validates server version from ping response
* Warn (not fail) if versions don't match
* Clear error message: "Connected to rfdb-server vX.Y.Z, expected vA.B.C"

## Prerequisites

* Version unification (RFD-41) should be done first ✅ (merged in main)

## Context

Discovered during RFD-40 exploration. Deferred because version numbers were out of sync.
RFD-41 unified versions, so now we can validate.
