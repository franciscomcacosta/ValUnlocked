-- 003: Versioned tools (browser scripts / bookmarklets / helper snippets)
-- that we hand to subscribers. Editable in the Supabase table editor so you
-- can fix the email grabber when Riot's frontend changes without a redeploy.

create table tools (
  name            text primary key,     -- slug, e.g. 'email_grabber'
  display_name    text not null,        -- "Riot Email Grabber"
  description     text,
  min_tier        sub_tier not null,    -- lowest tier that can access it
  script          text not null,        -- full console snippet, copy-pasteable
  bookmarklet     text,                 -- optional one-line javascript: URL variant
  instructions    text,                 -- markdown rendered in the bot DM / web page
  target_site     text,                 -- where the user runs it (hint for UI)
  version         integer not null default 1,
  updated_at      timestamptz not null default now()
);
alter table tools enable row level security;

-- Seed: email grabber (bump `version` any time you edit `script` so the bot
-- can advertise "updated" without comparing full strings).
insert into tools (name, display_name, description, min_tier, script, bookmarklet, instructions, target_site)
values (
  'email_grabber',
  'Riot Email Grabber',
  'Extracts the Riot account email from the merch store''s Apollo cache while you''re logged in.',
  'standard',
  $js$let cache = JSON.stringify(window.__APOLLO_CLIENT__.cache.extract());
let emails = cache.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
console.log("Emails found in Apollo Cache:", emails);$js$,
  $bm$javascript:(()=>{try{const c=window.__APOLLO_CLIENT__;if(!c){alert('Apollo client not found. Make sure you are on merch.riotgames.com and logged in.');return;}const emails=JSON.stringify(c.cache.extract()).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);if(!emails||!emails.length){alert('No email found. Try refreshing the page first.');return;}prompt('Account email (Ctrl+C to copy):',emails[0]);}catch(e){alert('Error: '+e.message);}})();$bm$,
  $md$**How to use the Email Grabber**

1. Log in to the account on **https://merch.riotgames.com** (any page works).
2. Open browser DevTools: **F12** → **Console** tab.
3. Paste the script above, hit **Enter**.
4. The email appears in the console output.

**Bookmarklet version (easier):** drag the "Email Grabber" button to your bookmarks bar. Then just click it while logged in on merch — a popup shows the email.

Once you have the email, rotate the recovery email on the Riot Account Management page to lock the account to you.$md$,
  'https://merch.riotgames.com'
);
