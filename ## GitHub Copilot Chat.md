## GitHub Copilot Chat

- Extension: 0.55.0 (prod)
- VS Code: 1.127.0 (4fe60c8b1cdac1c4c174f2fb180d0d758272d713)
- OS: win32 10.0.26200 x64
- GitHub Account: cjdawgs

## Network

User Settings:
```json
  "http.systemCertificatesNode": true,
  "telemetry.telemetryLevel": "all",
  "github.copilot.advanced.debug.useElectronFetcher": true,
  "github.copilot.advanced.debug.useNodeFetcher": false,
  "github.copilot.advanced.debug.useNodeFetchFetcher": true
```

Connecting to https://api.github.com:
- DNS ipv4 Lookup: 140.82.114.6 (40 ms)
- DNS ipv6 Lookup: Error (80 ms): getaddrinfo ENOTFOUND api.github.com
- Proxy URL: None (0 ms)
- Electron fetch (configured): HTTP 200 (25 ms)
- Node.js https: HTTP 200 (118 ms)
- Node.js fetch: HTTP 200 (80 ms)

Connecting to https://api.individual.githubcopilot.com/_ping:
- DNS ipv4 Lookup: 140.82.112.22 (47 ms)
- DNS ipv6 Lookup: Error (49 ms): getaddrinfo ENOTFOUND api.individual.githubcopilot.com
- Proxy URL: None (1 ms)
- Electron fetch (configured): HTTP 503 (89 ms)
- Node.js https: HTTP 503 (324 ms)
- Node.js fetch: HTTP 503 (81 ms)

Connecting to https://proxy.individual.githubcopilot.com/_ping:
- DNS ipv4 Lookup: 4.249.131.160 (43 ms)
- DNS ipv6 Lookup: Error (45 ms): getaddrinfo ENOTFOUND proxy.individual.githubcopilot.com
- Proxy URL: None (2 ms)
- Electron fetch (configured): HTTP 503 (122 ms)
- Node.js https: HTTP 503 (156 ms)
- Node.js fetch: HTTP 503 (133 ms)

Connecting to https://mobile.events.data.microsoft.com/OneCollector/1.0?cors=true&content-type=application/x-json-stream (Electron fetch): HTTP 200 (118 ms)
Connecting to https://telemetry.individual.githubcopilot.com/telemetry (Node.js https): HTTP 503 (133 ms)
Connecting to https://default.exp-tas.com/vscode/ab (Node.js fetch): HTTP 200 (106 ms)

Number of system certificates: 222

## Notes

- Active fetcher: Electron fetch.
- For corporate networks also see: [Troubleshooting firewall settings for GitHub Copilot](https://docs.github.com/en/copilot/troubleshooting-github-copilot/troubleshooting-firewall-settings-for-github-copilot).