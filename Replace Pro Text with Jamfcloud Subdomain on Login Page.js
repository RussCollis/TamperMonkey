// ==UserScript==
// @name         Replace Pro Text with Jamfcloud Subdomain on Login Page
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Replace 'Pro' text with the subdomain on the login page of *.jamfcloud.com domains.
// @author       Russ
// @match        *://*.jamfcloud.com/*
// @grant        none
// ==/UserScript==

(function () {
    "use strict";

    function replaceProText() {
        // Find the <h4> element containing "Pro" within the logo section
        const proHeader = document.querySelector("jp-logo h4");
        if (proHeader && proHeader.textContent.trim() === "Pro") {
            // Extract the subdomain from the current *.jamfcloud.com domain and capitalize it
            const subdomain = window.location.hostname.split(".")[0].toUpperCase();
            proHeader.innerHTML = `${subdomain}<br>Jamf Pro`; // Replace 'Pro' with the subdomain and add 'Jamf Pro' on a new line
        }
    }

    window.addEventListener("load", function () {
        // Wait for a while to ensure Angular and Shadow DOM have finished rendering
        setTimeout(replaceProText, 1500); // Adjust the timeout as needed
    });
})();
