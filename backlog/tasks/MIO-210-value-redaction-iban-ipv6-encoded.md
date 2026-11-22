---
id: MIO-210
title: Redaction refuses or masks IBANs, IPv6 addresses and encoded personal data in logs and event props
epic: EPIC-15
priority: P1
money_impact: none
risk_class: guard
status: todo
depends_on: [MIO-107, MIO-160]
size: M
estimate_hours_base: 12
estimate_hours: 15
---

## Goal

Personal data does not reach a log line or a product event through a value, even when its key is allowed.
Keys are an allow-list today; values are a deny-list with known holes.

## Scope

- Value rules in the logger's redaction and in the product-event prop validation: IBANs, IPv6 addresses
  (full and compressed), base64 or base64url text that decodes to JSON or text holding an email or a phone
  number, and a phone number of 9 or more digits held as a number.
- The same rules in both sinks (the log formatter and the product-event path), from one shared module.
- Keep the 18 earlier redaction probes green.

## Acceptance criteria

- A log message and a log field holding an IBAN, an IPv6 address (the textbook address and a compressed
  one) or base64 of `{"email":"a@b.co"}` come out censored. No raw value is in the output.
- A product event with a prop holding any of those values is refused, and the refusal does not echo the
  value.
- A 9-digit phone number as a numeric prop is refused.
- An ordinary value is not censored: an ISO date, a UUID, an amount of 12345 and a 6-digit order number
  pass in both sinks (a control test per value).
- Mutation: drop one value rule. Its probe goes red; the controls stay green.

## Notes

Source: the second re-review of the fix round (finding F3; six probes were red there). Classified as a
follow-up, not a release blocker.
