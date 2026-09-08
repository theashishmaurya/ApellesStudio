# Beta signup — three steps to make it live

The signup form on the home page is **fully built and working**: it validates the
address, disables while in flight, and renders real success and error states. The
only thing missing is a form endpoint, because creating a third-party account on
someone else's behalf is not something the agent that built this site is able to
do.

Until you do the steps below, the form validates and then tells the visitor
plainly that signup is not open yet. It does **not** post anywhere and does not
silently drop an address on the floor.

## 1. Create a free Formspree form

Sign up at <https://formspree.io> and create one form. The free tier allows 50
submissions per month, which is more than a pre-launch list needs to start.

Formspree gives you an endpoint that looks like:

```
https://formspree.io/f/abcdwxyz
```

`abcdwxyz` is your form's id.

## 2. Put the endpoint in the one named constant

Open `src/data/beta.ts` and replace the placeholder:

```ts
// before
export const BETA_FORM_ENDPOINT = 'https://formspree.io/f/YOUR_FORM_ID';

// after
export const BETA_FORM_ENDPOINT = 'https://formspree.io/f/abcdwxyz';
```

That is the only edit. Nothing else in the site references the endpoint, and
`isPlaceholderEndpoint()` stops returning `true` the moment the literal string
`YOUR_FORM_ID` is gone, which is what re-enables the real submit path.

## 3. Rebuild, and update the one test that asserts the placeholder

```bash
npm run verify
```

One test will now fail, on purpose:

```
tests/build-output.test.ts
  › keeps the beta endpoint an obvious placeholder until the owner sets one
```

It exists so the placeholder can never ship unnoticed. Once you have set a real
endpoint, delete that single test case — its job is done. Everything else should
stay green.

## What the form sends

| field | value |
|---|---|
| `email` | the address, validated client-side before submit |
| `role` | one of the four options, or empty if the visitor skipped it |
| `_gotcha` | a honeypot. Formspree discards any submission where this is filled |

## Using something other than Formspree

Any endpoint that accepts a `POST` of `multipart/form-data` and responds `2xx`
on success works unchanged — Getform, Basin, Netlify Forms, or your own handler.
The submit code sends `Accept: application/json` and treats `res.ok` as success.
Swap the URL in the same constant.

## Privacy note

The site loads no analytics and sets no cookies. The copy beside the form says
so, so if you add tracking later, change that copy too — it is a promise printed
on the page, not boilerplate.
