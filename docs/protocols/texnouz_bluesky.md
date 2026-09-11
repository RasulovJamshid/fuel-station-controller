# TexnoUz BlueSky transaction completion

An accepted start command (`C3`) leaves the sale in `Authorizing` until the
dispenser reports dispensing or paused status. Zero or small startup readings
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

These changes are in `dispenser-service` and apply only to TexnoUz BlueSky. Deploy
the rebuilt service using the normal site update procedure. No database migration
or configuration change is required. Existing history entries are not rewritten;
recovery across a service restart is outside this change.

Automated tests replay delayed starts, repeated authorization, late busy replies,
nozzle selection, stop/cancel commands, small fills, missing or unstable final
readings, and database failures through the protocol handler. Before rollout to
other sites, verify the reported delayed-start sequence on the physical dispenser
and confirm one history entry and one shift-total update for each sale.
