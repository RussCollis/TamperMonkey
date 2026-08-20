// ==UserScript==
// @name         Replace Pro Text with Jamfcloud Subdomain
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Replace 'Pro' text with the subdomain on *.jamfcloud.com domains.
// @author       Russ
// @match        *://*.jamfcloud.com/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    function replaceProText() {
        const shadowHost = document.querySelector("#side-nav-logo > a > jamf-nav-logo");
        if (shadowHost) {
            const shadowRoot = shadowHost.shadowRoot;
            if (shadowRoot) {
                const span = shadowRoot.querySelector("div > div:nth-child(2) > span");
                if (span && span.textContent.trim() === "Pro") {
                    // Extract the subdomain from the current *.jamfcloud.com domain and capitalize it
                    const subdomain = window.location.hostname.split(".")[0].toUpperCase();
                    span.innerHTML = `${subdomain}<br>Jamf Pro`; // Replace 'Pro' with the subdomain and add 'Jamf Pro' on a new line
                }
            }
        }
    }

    window.addEventListener("load", function () {
        // Wait for a while to ensure Angular and Shadow DOM have finished rendering
        setTimeout(replaceProText, 1000); // Adjust the timeout as needed
    });
})();
