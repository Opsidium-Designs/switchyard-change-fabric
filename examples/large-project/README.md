# large-project

A deliberately wide standalone TypeScript utility library used as the "Large"
scenario target for the Switchyard Change Fabric console. It has many small,
independent modules of exported functions and no cross-module dependencies, so a
universal goal (add input validation to every exported function) decomposes into
a wide, flat work graph with more than ten WorkUnits. That is the point: it
shows the fabric recruiting and coordinating a run at scale.

Each module trusts its callers and does no input validation yet, so every
exported function is real work for the validation goal. There are no path
collisions between modules, so the Large run is autonomous: it completes with no
human escalation step.

This project is example content only; it is not part of the fabric runtime.
