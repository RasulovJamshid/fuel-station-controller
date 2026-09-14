# TexnoUz BlueSky transaction completion

Sending a start command (`C3`) leaves the sale in `Authorizing` until the
dispenser reports dispensing or paused status. Ownership is retained even when
the Start acknowledgement is lost. Zero or small startup readings
remain part of the same transaction; they do not by themselves create cancelled
or completed history entries.

Saving requires a non-dispensing, non-paused status and one of these conditions:

- The nozzle is holstered.
- The dispenser acknowledged an application Stop command.
- Flow has been observed and the requested volume or amount has been reached.

The service checks status again after reading final data (`D9`), then requires
matching final readings on separate polls at least 750 ms apart. Missing replies,
resumed flow, changed readings, or readings below the last observed delivery break
confirmation. A failed database write retains the same transaction ID for retry.

Full-tank sales and fills below the requested preset therefore remain active until
the nozzle is returned or Stop is acknowledged. Genuine small fills are saved;
there is no minimum-volume filter. A confirmed zero-volume end is still cancelled.

The active transaction owns its nozzle. Another nozzle's status cannot close it.
Repeated Auth commands and display resets cannot replace the transaction, and a
completed sale holds the lane until polling observes the nozzle holstered and no
longer dispensing or paused. A Stop requested during startup is retried when the
dispenser reports flow.

Pre-authorization is a software-only reservation for one nozzle, price, and
preset. Accepting it performs a status check but sends no hose selection, control,
price, dose, or Start command. Normal status polling continues while the nozzle
is holstered. Only a lift of the reserved nozzle triggers hose selection, control
acquisition, price and dose writes, and Start. A fresh status check before Start
must still report that nozzle lifted and neither dispensing nor paused.
Authorization after an already-lifted nozzle uses the same setup path.

Cancel or Stop before device startup removes the software reservation immediately,
even if the dispenser has stopped replying. It clears the preset display and
timeout and publishes `PreAuthCancelled` plus an Idle snapshot, without creating
a transaction or waiting for a Stop acknowledgement or holster. A later nozzle
lift cannot start the cancelled reservation. The `pre_auth_cancel_wait` field is
null; clients using either layout receive the existing cancellation/status events.

The configured pre-authorization timeout is checked in the BlueSky protocol loop,
before polling and again before preparing a lifted nozzle. It cancels the
reservation even without a dispenser response. BlueSky does not use the shared
queued timeout task, avoiding a stale timeout cancellation acting on a later sale.
A timeout of zero still disables expiration. A setup failure before Start cancels
the reservation instead of repeatedly programming the pump on subsequent polls.

If Start was sent, cancellation retains the transaction and uses Stop, followed
by the normal final-meter checks. Unexpected flow without our Start is adopted
as a transaction and stopped, preserving its final meter readings. Active
Stop attempts are paced at one per second (with the normal exchange retries);
newly observed flow triggers an immediate attempt. This behavior needs physical
verification on the site's firmware; replay tests do not emulate a dispenser's
internal preset register or keypad.

These changes are in `dispenser-service` and apply only to TexnoUz BlueSky. Deploy
the rebuilt service using the normal site update procedure. No database migration
or configuration change is required. Existing history entries are not rewritten;
recovery across a service restart is outside this change.

Automated tests replay software reservations, local cancellation, timeout without
replies, deferred setup on lift, failed setup, delayed starts, repeated
authorization, late busy replies,
nozzle selection, stop/cancel commands, small fills, missing or unstable final
readings, and database failures through the protocol handler. Before rollout to
other sites, verify a two-minute reservation followed by cancel, timeout, and lift
on the physical dispenser and confirm one history entry and one shift-total update for each sale.
