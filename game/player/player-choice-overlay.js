export function presentPlayerChoiceOverlay({
    titleId,
    title,
    message,
    extraNodes = [],
    actions,
}) {
    const root = document.createElement('div');
    root.className = 'guest-progress-selection';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', titleId);

    const card = document.createElement('section');
    card.className = 'guest-progress-selection__card';

    const heading = document.createElement('h2');
    heading.id = titleId;
    heading.textContent = title;

    const messageEl = document.createElement('p');
    messageEl.className = 'guest-progress-selection__message';
    messageEl.id = `${titleId}-message`;
    messageEl.textContent = message;
    root.setAttribute('aria-describedby', messageEl.id);

    const actionRow = document.createElement('div');
    actionRow.className = 'guest-progress-selection__actions';
    const buttons = actions.map(({ label, choice, primary = false }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `guest-progress-selection__button${primary ? ' guest-progress-selection__button--primary' : ''}`;
        button.dataset.choice = choice;
        button.textContent = label;
        actionRow.appendChild(button);
        return button;
    });

    const status = document.createElement('p');
    status.className = 'guest-progress-selection__status';
    status.setAttribute('aria-live', 'polite');

    card.append(heading, messageEl, ...extraNodes, actionRow, status);
    root.appendChild(card);
    document.body.appendChild(root);

    const primaryButton = buttons.find((button) => button.classList.contains('guest-progress-selection__button--primary'))
        || buttons[0];
    primaryButton?.focus?.();

    return {
        root,
        buttons,
        setStatus(text) {
            status.textContent = text;
        },
        setBusy(busy) {
            for (const button of buttons) {
                button.disabled = busy;
            }
        },
        remove() {
            root.remove();
        },
    };
}
