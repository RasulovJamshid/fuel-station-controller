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

Cancelling a pre-authorization that has never sent `C3` first checks the owned
hose's `D5` status. If it has no dispensing, pause, or keypad-preset flag, the app
revokes its pending Start permission and waits for holster before releasing the
lane. Bit 3 (remote control) is not required: the site's TU_WB_KEY reports that
bit clear even during successful app-controlled sales. The
next authorization overwrites the stored price and dose. Cancellation does not
use `AA` (the keypad-preset flag) or wait for `CA` (Stop during dispensing).
Missing replies or a keypad preset keep cancellation pending;
ordinary status polling continues and no new Start is sent. Repeated operator
requests can add at most one cancellation status check per five seconds. The
pre-authorization timer is disarmed when cancellation is requested, preventing
repeated timeout notices for the same order.

API and WebSocket snapshots expose `pre_auth_cancel_wait` as `AWAITING_STATUS`
or `KEYPAD_PRESET` while an unstarted cancellation is blocked, and explicitly
send `null` when it resolves. Classic and modern desktop layouts display the
pending reason in place of the Cancel action. Ordinary polling completes the
cancellation automatically when a valid idle status arrives, including replies
with the remote-control bit clear. Rebuild both the service and desktop to ship
the protocol correction and its operator feedback.

If Start was sent or the hose reports unexpected flow, cancellation retains the
transaction and uses Stop, followed by the normal final-meter checks. Active
Stop attempts are paced at one per second (with the normal exchange retries);
newly observed flow triggers an immediate attempt. This behavior needs physical
verification on the site's firmware; replay tests do not emulate a dispenser's
internal preset register or keypad.

These changes are in `dispenser-service` and apply only to TexnoUz BlueSky. Deploy
the rebuilt service using the normal site update procedure. No database migration
or configuration change is required. Existing history entries are not rewritten;
recovery across a service restart is outside this change.

Automated tests replay delayed starts, repeated authorization, late busy replies,
nozzle selection, stop/cancel commands, small fills, missing or unstable final
readings, and database failures through the protocol handler. Before rollout to
other sites, verify the reported delayed-start sequence on the physical dispenser
and confirm one history entry and one shift-total update for each sale.
