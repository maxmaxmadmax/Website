/*  VOLUNTEER WITH US - the form on the Events page.
    Posts to the volunteerApply function; the applicant lands in the admin
    under that event > Volunteers, and the office gets an email.          */
(function () {
    'use strict';
    var vf = document.getElementById('ev-vol-form');
    if (!vf) return;
    vf.addEventListener('submit', function (e) {
        e.preventDefault();
        var msg = document.getElementById('ev-vol-msg'),
            btn = vf.querySelector('button[type="submit"]');
        var fd = new FormData(vf);
        var data = {
            eventId: vf.getAttribute('data-event'),
            name: fd.get('name'),
            email: fd.get('email'),
            phone: fd.get('phone'),
            roles: fd.getAll('roles'),
            availability: fd.get('availability'),
            message: fd.get('message')
        };
        btn.disabled = true;
        btn.textContent = 'Sending\u2026';
        msg.hidden = true;
        fetch('https://australia-southeast1-soundzgood-8c86f.cloudfunctions.net/volunteerApply', {
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
                vf.querySelectorAll('input, textarea, fieldset').forEach(function (el) {
                    el.disabled = true;
                });
                btn.textContent = res.already ? '\u2713 Already on the list' : '\u2713 Thanks - we\u2019ll be in touch';
                msg.hidden = false;
                msg.textContent = res.already
                    ? 'You\u2019ve already put your hand up for this one - we have your details.'
                    : 'Thank you! Max will text or email you before the event.';
            })
            .catch(function (err) {
                btn.disabled = false;
                btn.textContent = 'Count me in \u2192';
                msg.hidden = false;
                msg.textContent = err.message || 'That didn\u2019t go through - try again.';
            });
    });
})();
