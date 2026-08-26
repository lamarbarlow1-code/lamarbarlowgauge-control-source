# Exact Drop-In Steps — No Supabase

Use this when you do not have Supabase.

1. Put these files into the existing Master Control source:

public/gauge-stack-controller.html
public/gauge-stack-controller.css
public/gauge-stack-controller.js
netlify/functions/gauge-stack-agent.mts
package.json

2. Keep the public adapter and its `gauge-public-ingress` Blob store on the same
   existing site. Master Control now reads those records directly.

3. Add this link to the existing main page:

<a href="/gauge-stack-controller.html">Open Gauge Stack Controller</a>

4. Redeploy the same Netlify project:

gsd-gauge-master-control

5. Open:

https://gsd-gauge-master-control.netlify.app/controller

6. Authenticate with the owner key, review the Intake Queue, and press:

Sync Gauge Stack

No Supabase keys needed. No replacement app. No second intake database.


Recommended production custody setting:
In Netlify → Site configuration → Environment variables, add:
GAUGE_OWNER_KEY = your private owner key

Then redeploy. When pressing Sync Gauge Stack, enter that owner key.
