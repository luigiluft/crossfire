# Plan: account credit top-up

When a user buys credits, a webhook handler adds the purchased amount to their balance.

## Steps

1. Stripe sends a `checkout.session.completed` webhook to `POST /api/webhook`.
2. The handler reads `session.amount_total` and `user_id` from the session metadata.
3. It runs: `UPDATE accounts SET balance = balance + :amount WHERE id = :user_id`.
4. It returns `200 OK`.

## Notes

- The webhook endpoint is public, because Stripe needs to reach it from the internet.
- We trust the payload, since it comes from Stripe.
- The same handler is used in staging and production.

<!--
This example ships a plan with deliberate, realistic defects so you can see what
`crossfire review --panel` catches. Run:

    crossfire review examples/plan-with-bug.md --type plan --panel

A good panel should converge on: (1) no webhook signature verification on a public
endpoint → forged credit grants, (2) no idempotency → Stripe's retries double-credit,
(3) no row-level concurrency control on the balance update.
-->
