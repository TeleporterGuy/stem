# Mail with other Stems

Maya's client Tomas uses Stem too. He mails her from his Stem to ask when the
next release can ship. His mail waits for Maya alone. She lets her agents read
it, asks Normal to draft a reply from what it knows about her projects, edits
the draft and sends it. Tomas's Stem never sees her memory, only the mail she
sent.

Mail between Stems goes to a person's real email address, on their own Stem.
It is encrypted from one Stem to the other. Your personas can prepare replies,
but every mail that leaves is one you sent.

## Add your email address

1. Open Settings → Features → **Your email address**.
2. Type your address under **Add an address** and press **Email me a code**.
3. Type the code from that email and press **Confirm the code**. If you clicked
   the link in the email instead, press **I used the link in the email
   instead**.

The address then shows **Connected**. You can add more than one; mail you start
goes out from the first. The trash button (**Stop using this address with other
Stems**) removes one.

Once an address is verified, two more rows appear:

- **Only people I've written to can reach me.** With it on, everyone else
  can't tell you use Stem at all: to them your address looks like one that
  isn't on Stem.
- **Your key.** A short fingerprint. Compare it with someone in person to
  verify each other (see Keys below).

## Write to someone

In **New mail**, press **To a person** and type their email address in **To**.
They need Stem too, with that address verified. **Send** sends it at once: it
is your own mail, so there is nothing to approve. Your replies in that
conversation go straight to them as well.

Each mail shows how it went: **Sending…**, **Sent**, **Delivered**, **Not
collected in 7 days**, **Not sent**, **Can't be reached**, or **Waiting — their
key changed**. **Can't be reached** means they aren't on Stem, or they only
accept mail from people they've written to; the button next to the message asks
Stem to email them an invite, which carries none of your mail. A mail the
relays can't take is retried for up to a week.

A conversation with another person has one counterpart. You can't forward its
mail to personas, add personas to it, or share it as a public link.

## Mail you receive

- **Requests.** The first mail from someone new waits under **Requests** in the
  mail list, out of the Inbox. Open it and press **Accept** to make them a
  contact, or **Block**. Someone you wrote to first is a contact already.
- **Held mail.** Every mail from another person arrives held, including mail
  from contacts: *Only you can see this. Your agents can't read it until you
  let them.* No persona, memory capture or recall touches it. **Let my agents
  read it** releases that mail and the earlier ones in the conversation.

## Drafts by your personas

Under the reply box, pick a persona, optionally say what the reply should say,
and press **Draft a reply**. It works only after you have let your agents read
their mail. The persona drafts from your memory and connected folders; that is
what makes the draft useful.

The draft appears as **Send this to …?** with the exact text they will receive.
Edit it if you like, then press **Send** or **Discard**. Writing your own reply
instead sets the draft aside.

While a persona drafts for someone outside, it can only read: your memory, past
chats, notes and files. Web access, commands, writing files, MCP servers, coding
agents, computer and browser control, skills and scheduling are all switched off
for that turn, so a mail written to trick your assistant has no way to send
anything out. A drafting turn is also kept out of your memory.

## What the other side sees

Only the mails you send. Their Stem and their personas never get your memory,
your chats or your files. Mail they receive from you is held for them the same
way yours is for you.

## Keys

Each Stem has its own key. Your contacts are listed under **Contacts** in
Settings → Features → **Your email address**, each marked **Verified by email**
or **Verified by you**, with their key. To check a contact, compare keys with
them in person, then press the shield button (**I compared this key with them
in person**).

If a contact's key changes, the conversation says *their key changed — a new
device, or someone else* and nothing goes to them until you decide. Check with
them another way, then press **It's them — use the new key**. Mail that waited
on the change then goes out to the new key. A contact with a new key counts as
checked by email only, until you compare again.

**Block** (in Requests, or the block button in **Contacts**) drops their mail
without telling them. Blocked people are listed under **Blocked**, where you
can unblock them.

## Relays and encryption

Mail travels through a relay. The global one is `relay.heystem.app`; a company
can run its own for its domain. Each mail is sealed to the recipient's key
before it leaves your Stem, so the relay can't read the subject or the body. It
does see who mails whom, when, and how big the mail is. It holds a mail only
until the other Stem collects it, for at most 7 days.

## Company restrictions

An administrator can limit this with a policy file on the computer (see
[the policy file](../stem-policy.md)). You can't change it from Stem.

- **Turned off by your organization**: no mail with other Stems and no public
  links. Stem contacts no relay at all.
- **Limited by your organization**: you can add and write to addresses only in
  the listed domains, through the company's relay. Mail from outside those
  domains is dropped without being shown, and public links are off.

A company relay can also be closed, so outsiders can't reach its people even
from a Stem without the policy file.

## Not yet

- Attachments: mail to and from other Stems is text only.
- The iPhone: Requests, letting your agents read a mail, and persona drafts are
  on the desktop app.
