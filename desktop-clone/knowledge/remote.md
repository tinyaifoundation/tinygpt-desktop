# Remote Control and paired devices

Settings → Remote Control lets paired devices access shared chats while the desktop application is open. Your computer must remain connected and available. Remote access is not an independent cloud copy that can keep working after the desktop is closed.

## Pair a device

Open Paired devices, choose Add device and follow the QR-code pairing flow on the intended device. Treat pairing information as access information. Confirm the device and choose its conversation access. The companion interface provides supported chat, attachment, model, queue, notification and settings views; desktop and mobile controls need not be identical.

## Read Chat and Work on a phone

The companion uses the desktop message components. Chat shows one tool chain with a single replaceable progress message below it, followed by the final answer. Progress disappears when the harness identifies the answer; model-specific answer validation still applies.

Generated UI answers, including tables, charts, checklists and suggested follow-up questions, also appear on mobile. A visual answer hides temporary progress as soon as it begins. The companion uses the same tool icons as desktop, including mapped plugin icons. Follow-up buttons fill the message composer for review; they do not send a message automatically. Preview visuals remain non-interactive until completed.

Generated visuals are fetched separately through the encrypted, paired connection for an authorized conversation. Only validated display components are returned, without the raw tool result. Mobile retains references for up to 96 recent visuals in its recent message window; older visuals remain available on desktop. This does not grant account, file or browser control beyond the device's existing permissions.

Work shows chronological prose and tool activity, with delegated coding inside an inline **Coding agent** section. The section opens while its coding call is active and collapses when that call ends. The outer Work history stays open until the assistant’s answer is confirmed, then collapses; tap it to review retained activity. A completed coding call alone does not mark the whole task complete.

Mobile receives a bounded recent display rather than the desktop’s full native session. Retained child tools keep their Coding agent parent and ownership, even when the parent is older than the ordinary recent-tool window. Long notes are truncated with the existing omission indication; full history remains on the computer. This does not grant file access or add raw tool results or full command output to the companion. File targets in tool display metadata are reduced to file names. Available message actions and approvals still depend on the paired device’s access.

## Talk to your Bot on mobile

After setting up your Bot on desktop, open the companion sidebar and tap its name and animated avatar. The Bot name aligns with New chat, and its animated avatar occupies the same icon column and visual size. Devices with conversation-library access can see your personal Bot. A device paired to just one ordinary chat does not gain Bot access; pairing directly to the personal Bot shares only that conversation. The same persistent Bot conversation, custom avatar, message bubbles, reactions and incoming messages appear on phone and desktop. This does not create a separate mobile Bot or move its runtime to the phone.

Tap the Bot name/avatar above the messages to open its information sheet, with its status, browser availability and Keeping an eye on watch titles and next-check times. Snooze and Wake up control the same saved sleeping state as desktop: sleeping stops replies and proactive work until you wake it. The animation and composer reflect sleeping on both devices. Individual watch management, Bot appearance editing, memory/permissions setup and watching or controlling its workspace browser remain on desktop. The browser availability shown on mobile is not a remote browser-control surface.

Main Bot messages can appear in companion notifications and paired-device push notifications according to notification preferences. Only the configured personal Bot is shared; private internal watch conversations, their prompts, raw results, memory notes and plugin grants are not added to the mobile library. Normal conversation-scoped device restrictions and revocation still apply. Your desktop must stay open and connected for Bot replies or proactive messages to reach the phone.

## Limit or revoke access

Use Paired devices to change shared conversation access or revoke an individual device. Allow remote connections turns availability on or off while preserving saved paired devices. Remove all remote access forgets every paired device; each will need a new QR code to reconnect. Revocation prevents later access and cannot retract information already viewed by a device.

Keep this computer awake prevents automatic system sleep while remote connections are allowed; the display can still turn off. It does not prevent shutdown, lost internet or application failure. Check Connection status when the companion cannot connect, then confirm the desktop is open, remote access is enabled and the device is still paired.

Remote transport uses the configured relay and device pairing/cryptography. This does not change the selected model's privacy behavior: cloud inference still receives prompts and relevant context. Notification previews can reveal information on a device's screen; review both TinyGPT and device notification settings.

The main website at https://tinygpt.org/downloads includes a **Remote Control** link below the desktop installers. It opens https://mobile.tinygpt.org, where you can install the mobile web app or continue in the browser. A running desktop app and approved pairing are still required; this is not independent hosted inference.
