// ==UserScript==
// @name         Your_ORG Jamf Pro - Teams Deep Link Linkifier
// @namespace    Your_ORG.jamfpro.teamslink
// @version      1.0
// @description  Turns the plain-text Teams deep-link EA value shown on Jamf Pro computer inventory pages into a real clickable hyperlink.
// @author       Russell Collis
// @match        https://*.jamfcloud.com/*
// @match        https://*/legacy/computers.html*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
=============================================================================
[Your_ORG] 2026
=============================================================================
Your_ORG Jamf Pro - Teams Deep Link Linkifier
=============================================================================
Description:   Browser userscript (Tampermonkey/Userscripts extension) that
               scans the rendered Jamf Pro computer inventory page for the
               plain-text Teams deep-link URL produced by the "Teams Chat
               Deep Link" Extension Attribute, and rewrites any matching
               text nodes into real clickable <a> hyperlinks. This exists
               purely because Jamf Pro does not render Extension Attribute
               values as HTML/hyperlinks server-side - this is a
               client-side, browser-only workaround.

Author:        Russell Collis
Created:       29/07/2026
Version:       1.0

Requirements:  - Tampermonkey (or Userscripts) browser extension installed
               - Teams Chat Deep Link Extension Attribute deployed and
                 populating computer inventory records
               - Adjust the @match line above to your Jamf Pro URL

Output:        No script output - purely a visual/interaction change made
               to the rendered Jamf Pro page in the browser.

IMPORTANT:     This script is specifically designed for Your_ORG's macOS
               environment and internal Jamf Pro instance and should only
               be used within Your_ORG's managed infrastructure/tooling. It
               contains organisation-specific configurations and should
               not be used outside of this intended environment.
=============================================================================
=============================================================================
Changelog
=============================================================================
  29/07/2026 - v1.0 - Russell Collis
    - Initial version. Scans rendered page text for Teams deep-link URLs
      and rewrites them as clickable hyperlinks, since Jamf Pro EA values
      are always displayed as plain text and cannot be hyperlinked
      server-side.
=============================================================================
*/

(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // Regex matching the Teams deep-link URL format produced by the Teams
    // Chat Deep Link Extension Attribute, e.g.
    // https://teams.microsoft.com/l/chat/0/0?users=name@Your_ORG.com
    // -----------------------------------------------------------------------
    const teamsLinkPattern = /https:\/\/teams\.microsoft\.com\/l\/chat\/0\/0\?users=[^\s<>"']+/g;

    // -----------------------------------------------------------------------
    // Walks the DOM and finds text nodes (ignoring script/style tags) that
    // contain a Teams deep-link URL, then replaces the matched text with a
    // real anchor element so it becomes clickable in the browser.
    // -----------------------------------------------------------------------
    function linkifyTeamsLinks(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                const parentTag = node.parentNode && node.parentNode.tagName;
                if (parentTag === 'SCRIPT' || parentTag === 'STYLE' || parentTag === 'A') {
                    return NodeFilter.FILTER_REJECT;
                }
                return teamsLinkPattern.test(node.nodeValue)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT;
            }
        });

        // Reset lastIndex since .test() above advances it on the global regex
        teamsLinkPattern.lastIndex = 0;

        const nodesToProcess = [];
        let currentNode;
        while ((currentNode = walker.nextNode())) {
            nodesToProcess.push(currentNode);
        }

        nodesToProcess.forEach(function (textNode) {
            const originalText = textNode.nodeValue;
            teamsLinkPattern.lastIndex = 0;

            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            let match;

            while ((match = teamsLinkPattern.exec(originalText)) !== null) {
                // Append any plain text before the match
                if (match.index > lastIndex) {
                    fragment.appendChild(
                        document.createTextNode(originalText.slice(lastIndex, match.index))
                    );
                }

                // Build the clickable anchor for the matched Teams URL
                const anchor = document.createElement('a');
                anchor.href = match[0];
                anchor.textContent = 'Start Teams Chat';
                anchor.title = match[0];
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                anchor.style.fontWeight = 'bold';
                fragment.appendChild(anchor);

                lastIndex = match.index + match[0].length;
            }

            // Append any remaining plain text after the final match
            if (lastIndex < originalText.length) {
                fragment.appendChild(document.createTextNode(originalText.slice(lastIndex)));
            }

            textNode.parentNode.replaceChild(fragment, textNode);
        });
    }

    // -----------------------------------------------------------------------
    // Run once on page load, then re-run whenever Jamf Pro's single-page-app
    // updates the DOM (e.g. switching tabs on a computer record), since new
    // EA values can be rendered dynamically after the initial page load.
    // -----------------------------------------------------------------------
    linkifyTeamsLinks(document.body);

    const observer = new MutationObserver(function () {
        linkifyTeamsLinks(document.body);
    });

    observer.observe(document.body, { childList: true, subtree: true });
})();
