const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.addInitScript(() => {
        localStorage.setItem('token', 'frontend-dom-smoke-token');
    });

    await page.goto('http://127.0.0.1:8000/calendar-ui', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const result = await page.evaluate(() => {
        const mk = (id) => {
            const el = document.getElementById(id);
            if (!el) return { exists: false };
            const svg = !!el.querySelector('svg');
            const label = (el.querySelector('.btnLabel')?.textContent || '').trim();
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            return { exists: true, svg, label, text, html: el.innerHTML };
        };
        return {
            createBtn: mk('createBtn'),
            accountsBtn: mk('accountsBtn'),
            path: window.location.pathname,
            title: document.title,
        };
    });

    console.log(JSON.stringify(result, null, 2));

    const failures = [];
    if (!result.createBtn.exists) failures.push('createBtn missing');
    if (!result.accountsBtn.exists) failures.push('accountsBtn missing');
    if (!result.createBtn.svg) failures.push('createBtn missing svg icon');
    if (!result.accountsBtn.svg) failures.push('accountsBtn missing svg icon');
    if (result.createBtn.label !== 'Create / Import') failures.push(`createBtn label mismatch: ${result.createBtn.label}`);
    if (result.accountsBtn.label !== 'Account Menu') failures.push(`accountsBtn label mismatch: ${result.accountsBtn.label}`);

    await browser.close();

    if (failures.length) {
        console.error('VERIFY_FAILED');
        failures.forEach((f) => console.error('- ' + f));
        process.exit(2);
    }

    console.log('VERIFY_OK');
})();
