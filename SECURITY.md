# Security Policy

Koinonia handles stream keys and can act on live channels, so we take security seriously. The project is pre-alpha; see the [security model](https://developerfred.github.io/koinonia/docs/security/) for the design commitments.

## Supported versions

Only the `main` branch is supported until the first tagged release.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting: https://github.com/developerfred/koinonia/security/advisories/new

Include what you found, steps to reproduce, and the impact. You will get an acknowledgement within a few days. We will coordinate a fix and credit you if you wish.

## Scope highlights

- Stream key or token exposure (logs, errors, network, browser).
- Bypassing human confirmation for sensitive actions (`ban_user`, going live).
- Daemon exposure beyond loopback, missing origin or token checks.
- Injection through chat content into tool results or the agent context.

## Handling secrets

Never put stream keys in command lines, files or issues. If you leaked one, rotate it on the platform immediately.
