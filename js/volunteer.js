/* ==========================================================================
   VOLUNTEER WITH US  -  the form on the Events page (#ev-vol-form)

   Posts to the volunteerApply function; the applicant lands in the admin
   under that event > Volunteers, and the office gets an email.

   CONTENTS
     SETUP    the form and the function URL
     SEND     read the form, post it, show the answer
   ========================================================================== */
(function () {
    'use strict';

    /* ---- SETUP ---- */
    var URL = 'https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/volunteerApply';
    var vf = document.getElementById('ev-vol-form');
    if (!vf) return;

    /* ---- SEND ---- */
    function formData() {
        var fd = new FormData(vf);
        return {
            eventId: vf.getAttribute('data-event'),
            name: fd.get('name'),
            email: fd.get('email'),
            phone: fd.get('phone'),
            roles: fd.getAll('roles'),
            availability: fd.get('availability'),
            message: fd.get('message')
        };
    }

    vf.addEventListener('submit', function (e) {
        e.preventDefault();
        var msg = document.getElementById('ev-vol-msg');
        var btn = vf.querySelector('button[type="submit"]');
        var data = formData();
        btn.disabled = true;
        btn.textContent = 'Sending…';
        msg.hidden = true;
        fetch(URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: data })
        })
            .then(function (r) {
                return r.json();
            })
            .then(function (j) {
                var res = (j && j.result) || {};
                if (!res.ok) throw new Error((j && j.error && j.error.message) || 'Could not send.');
                // sent: lock the form and say thanks
                vf.querySelectorAll('input, textarea, fieldset').forEach(function (el) {
                    el.disabled = true;
                });
                btn.textContent = res.already ? '✓ Already on the list' : '✓ Thanks - we’ll be in touch';
                msg.hidden = false;
                msg.textContent = res.already
                    ? 'You’ve already put your hand up for this one - we have your details.'
                    : 'Thank you! Max will text or email you before the event.';
            })
            .catch(function (err) {
                btn.disabled = false;
                btn.textContent = 'Count me in →';
                msg.hidden = false;
                msg.textContent = err.message || 'That didn’t go through - try again.';
            });
    });
})();
