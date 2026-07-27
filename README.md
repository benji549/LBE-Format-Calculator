# LBE Team Calculator

A browser-based collaborative calculator for creating, sharing, versioning, and comparing location-based entertainment business models.

## Included features

- Passwordless email sign-in with Supabase Auth
- Team-visible and private formats
- Owner-only editing and deletion
- Teammate viewing, comparison, and duplication
- Up to four formats in one comparison
- Automatic version history with change notes
- Optimistic concurrency protection against stale overwrites
- Realtime library refresh for low-volume team use
- Capacity, attendance, revenue, expenses, profit, margin, break-even utilization, and per-m² metrics
- Custom uncertainty sliders for primary inputs and expenses
- Recurring monthly/annual expenses and one-time Year 1 expenses

## Project files

- `index.html`: application shell and dialogs
- `styles.css`: responsive interface styles
- `app.js`: UI, authentication flow, editor, comparison, and version history
- `calculator.js`: calculation logic and format data model
- `db.js`: Supabase client and database operations
- `config.js`: your Supabase Project URL and publishable key
- `supabase/schema.sql`: database tables, functions, triggers, grants, RLS policies, and Realtime setup

## 1. Create a Supabase project

1. Sign in to Supabase and create a new project.
2. Wait for the database to finish provisioning.
3. Open **SQL Editor**.
4. Create a new query.
5. Copy the complete contents of `supabase/schema.sql` into the editor.
6. Select **Run**.

The script creates:

- `profiles`
- `formats`
- `format_versions`
- Auth/profile triggers
- Automatic version-history triggers
- The atomic `update_lbe_format` database function
- Row Level Security policies
- Explicit API grants
- A Realtime publication entry for `formats`

## 2. Copy the browser-safe project credentials

1. In Supabase, open your project's **Connect** dialog or **Settings > API Keys**.
2. Copy the **Project URL**.
3. Copy the **Publishable key**. A legacy `anon` key also works, but a publishable key is preferred for a new setup.
4. Open `config.js` and replace the placeholders:

```js
export const APP_CONFIG = {
  supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
  supabasePublishableKey: 'YOUR_SUPABASE_PUBLISHABLE_KEY',
  appName: 'LBE Format Calculator',
  maxComparedFormats: 4,
};
```

Never place a secret key or `service_role` key in `config.js` or any other browser file.

## 3. Configure sign-in redirects

1. In Supabase, open **Authentication > URL Configuration**.
2. During local testing, add:

```text
http://localhost:8080/**
```

3. After hosting, set **Site URL** to the production home page, for example:

```text
https://lbe-calculator.example.com
```

4. Add the same production address under **Redirect URLs**. A trailing wildcard is useful when the host may add a path:

```text
https://lbe-calculator.example.com/**
```

The app passes its current page as `emailRedirectTo`, so that page must be allowed in Supabase.

## 4. Choose who may create accounts

For an internal team tool, an invite-only configuration is safest:

1. Open **Authentication > Sign In / Providers** or the current Auth general configuration page.
2. Keep the Email provider enabled.
3. Disable **Allow new users to sign up** after you have invited or created the approved users.
4. Open **Authentication > Users** and invite each teammate.

Existing invited users can use the app's magic-link form. With new signups disabled, unknown users cannot create accounts merely by entering an email address.

## 5. Configure email delivery

Supabase's default email service is suitable only for initial testing and has significant restrictions and rate limits. For normal team use, configure Custom SMTP under the project's Authentication settings.

You can use an SMTP service such as your company mail provider, Amazon SES, Postmark, SendGrid, Resend, Brevo, or another SMTP-compatible provider.

Customize the Magic Link email under **Authentication > Email Templates** if desired.

## 6. Test locally

Because the project uses JavaScript modules, serve the folder through a local HTTP server rather than opening `index.html` directly.

From the project folder, run either:

```bash
python -m http.server 8080
```

or on systems where Python is named `python3`:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Test this flow:

1. Sign in with an invited email.
2. Create a format and publish it.
3. Open a private/incognito window and sign in as a second teammate.
4. Confirm the second user can view and compare the team-visible format but cannot edit it.
5. Duplicate the first user's format and confirm the copy is owned by the second user.
6. Save multiple versions and open **History**.
7. Open the same owned format in two tabs, edit both, save one, and verify the second tab receives a conflict instead of silently overwriting the first save.

## 7. Host the application

This is a static site, so no custom application server is needed.

### Netlify

1. Put all project files in a GitHub repository, or drag the folder into Netlify's deployment interface.
2. Publish the repository root.
3. No build command is required.
4. Copy the generated HTTPS address into Supabase's Site URL and Redirect URLs.

### Vercel

1. Import the GitHub repository into Vercel.
2. Choose **Other** as the framework if prompted.
3. Leave the build command empty.
4. Use the repository root as the output directory.
5. Add the resulting HTTPS address to Supabase Auth URL Configuration.

### Cloudflare Pages

1. Connect the repository to Cloudflare Pages.
2. Select a static/no-framework project.
3. Do not specify a build command.
4. Set the output directory to the repository root.
5. Add the production address to Supabase Auth URL Configuration.

### GitHub Pages

GitHub Pages can also host these static files. Make sure the deployed `config.js`, `index.html`, and module files remain in the same relative folder structure. Add the GitHub Pages URL to Supabase's allowed redirect URLs.

## Permissions implemented by the SQL

- All authenticated users can read profiles needed to show format owners.
- Owners can see their own private or team-visible formats.
- Other authenticated users can see only team-visible formats.
- A user can insert a format only when `owner_id` and `updated_by` match their Auth user ID.
- Only owners can delete their formats.
- Direct database updates from the browser are not granted.
- Updates go through `update_lbe_format`, which verifies ownership and the expected version number before updating.
- Version history is inserted automatically by a database trigger.
- Users can read version history only for formats they are allowed to see.

## How version conflicts work

Every format has a `version_number`.

When the browser loads Version 5, it sends `expected_version = 5` during save. The database locks the row and saves only if the current database version is still 5. If another tab has already created Version 6, the function raises a `VERSION_CONFLICT` error.

The app then offers to save the older draft as a new private copy instead of overwriting the newer work.

## Data model

The complete calculator state is stored in the `format_data` JSONB column. This keeps sliders, expense rows, and future assumptions together while the commonly displayed metadata remains in normal columns:

- `name`
- `description`
- `visibility`
- `currency`
- `owner_id`
- `version_number`
- `created_at`
- `updated_at`

Every saved version is copied into `format_versions` by a trigger.

## Production checklist

- [ ] Replace the placeholder values in `config.js`.
- [ ] Run `supabase/schema.sql` successfully.
- [ ] Verify RLS is enabled on all three public tables.
- [ ] Use only the publishable or legacy anon key in the browser.
- [ ] Disable open signup and invite approved teammates.
- [ ] Configure the production Site URL and Redirect URLs.
- [ ] Configure Custom SMTP for reliable email sign-in.
- [ ] Test with two separate user accounts.
- [ ] Enable database backups appropriate to the importance of the data.
- [ ] Put the code in GitHub so changes are reviewed and recoverable.

## Current collaboration model

The original creator owns a format. Other teammates can view, compare, and duplicate it, but cannot edit the original. This avoids ambiguous ownership and accidental overwrites.

To support named editors later, add a `format_collaborators` table and update the RLS policies and `update_lbe_format` function to recognize an `editor` role.
