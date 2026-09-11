# Job Tracker Clipper (unpacked MV3 extension)

1-click intake: while viewing a posting you are already logged into, click the
toolbar button. The extension captures the tab's URL, title, selected text,
and rendered DOM, then POSTs them to your localhost tracker with your clip
token. No cookies, passwords, or session credentials are accessed — the
manifest does not even request cookie permission.

## Install (Chrome or Brave, unpacked)

1. Start the tracker (`npm run dev`) and open `/intake`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load
   unpacked**, and select this `extensions/clipper/` directory.
3. Open the extension's **Options** (or click the toolbar button once) and
   paste the clip token shown on `/intake`. Use **Test connection** to verify
   the tracker answers, then **Save**.
4. Browse to any posting and click the toolbar button. The badge shows `OK`
   (new card), `DUP` (already tracked), `FAIL` (rejected with a reason), or
   `ERR` (capture/network/token problem — hover for detail).

If the tracker runs on a different port, set the base URL on the options page
first (for example `http://127.0.0.1:3101`).
