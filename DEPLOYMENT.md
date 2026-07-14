# Deployment Notes

## Deployed Commit
- Deployed Git commit: `cd9081b` (`Split CLI from backend`)

## Local API On The OpenClaw Server
- The backend responded on the server at `http://127.0.0.1:8787`.
- `curl http://127.0.0.1:8787/registration` returned the expected registration JSON.
- `habitat status` on the server reported the registered Habitat normally.

## Laptop CLI Through Tailscale
- The laptop CLI was pointed at the OpenClaw server with `HABITAT_API_BASE_URL=http://<server-ip>:8787`.
- Running `habitat status` from the laptop reached the server backend through Tailscale.
- The backend terminal printed new request logs when the laptop command ran.

## Request Logs Observed
- Example backend log lines observed during the remote CLI workflow:
  - `[habitat-api] GET /registration -> registered`
  - `[kepler] GET /habitats/... -> 200`

## After Stopping The Manual Server
- After pressing `Ctrl+C` in the backend terminal, the laptop CLI could no longer connect.
- That failure was expected because no process was listening on port `8787`.

## Why `0.0.0.0` Was Required
- The server must bind to `0.0.0.0` so it listens on every network interface.
- That allows another machine to reach it over Tailscale or the local network.
- `0.0.0.0` is only a bind address, not a client URL.

## Why `.env` And `habitat.sqlite` Stay Ignored
- `.env` holds local configuration and credentials.
- `habitat.sqlite` holds the local Habitat state and may also contain sensitive data.
- Both files stay in the checkout for the deployed app, but Git must ignore them so they are not committed.
