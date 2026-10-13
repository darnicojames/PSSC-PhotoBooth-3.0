(() => {
    const root = document.documentElement;
    try {
        root.dataset.appearance = localStorage.getItem('pssc-appearance') === 'dark' ? 'dark' : 'light';
    } catch {
        root.dataset.appearance = 'light';
    }

    document.addEventListener('DOMContentLoaded', () => {
        const toggle = document.getElementById('btnAppearance');
        const updateToggle = () => {
            const dark = root.dataset.appearance === 'dark';
            toggle.setAttribute('aria-pressed', String(dark));
            toggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} appearance`);
            toggle.title = toggle.getAttribute('aria-label');
        };
        updateToggle();
        toggle.addEventListener('click', () => {
            root.dataset.appearance = root.dataset.appearance === 'dark' ? 'light' : 'dark';
            try {
                localStorage.setItem('pssc-appearance', root.dataset.appearance);
            } catch {
                // Appearance still works when browser storage is unavailable.
            }
            updateToggle();
        });

        const navigation = document.querySelectorAll('.nav-btn');
        document.getElementById('navBooth').setAttribute('aria-current', 'page');
        navigation.forEach(button => button.addEventListener('click', () => {
            navigation.forEach(item => item.removeAttribute('aria-current'));
            button.setAttribute('aria-current', 'page');
        }));
        document.getElementById('btnCameraSettings').addEventListener('click', () => {
            document.getElementById('navSettings').click();
            document.getElementById('cameraSelect').focus();
        });
        document.getElementById('psdDropzone').addEventListener('keydown', event => {
            if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                document.getElementById('psdFileInput').click();
            }
        });

        // Existing modal close handlers retain their session and playlist cleanup.
        const shell = document.querySelector('.app-shell');
        const dialogs = Array.from(document.querySelectorAll('.modal-backdrop'));
        let activeDialog = null;
        let returnFocus = null;
        const focusable = dialog => Array.from(dialog.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex="0"]'
        )).filter(element => !element.disabled && element.getClientRects().length);
        const syncDialog = () => {
            const openDialog = dialogs.find(dialog => !dialog.classList.contains('hidden'));
            if (openDialog === activeDialog) return;
            if (openDialog) {
                if (!activeDialog) returnFocus = document.activeElement;
                activeDialog = openDialog;
                shell.inert = true;
                focusable(openDialog)[0]?.focus();
            } else {
                activeDialog = null;
                shell.inert = false;
                if (returnFocus?.isConnected) returnFocus.focus();
            }
        };
        const observer = new MutationObserver(syncDialog);
        dialogs.forEach(dialog => observer.observe(dialog, { attributes: true, attributeFilter: ['class'] }));
        document.addEventListener('keydown', event => {
            if (!activeDialog) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                activeDialog.querySelector('.modal-close')?.click();
            } else if (event.key === 'Tab') {
                const items = focusable(activeDialog);
                const first = items[0];
                const last = items[items.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
        });
    });
})();
