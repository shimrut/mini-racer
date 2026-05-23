export class AchievementsUi {
    constructor({ modal } = {}) {
        this.modal = modal;
        this.bindEvents();
    }

    get achievementsBtn() { return document.getElementById('menu-btn-achievements'); }
    get achievementsModal() { return document.getElementById('achievements-modal'); }
    get achievementsBackBtn() { return document.getElementById('achievements-back-btn'); }
    get achievementsList() { return document.getElementById('achievements-list'); }

    bindEvents() {
        if (this.achievementsBtn) {
            this.achievementsBtn.addEventListener('click', () => {
                this.openAchievements();
            });
        }
        if (this.achievementsBackBtn) {
            this.achievementsBackBtn.addEventListener('click', () => {
                this.closeAchievements();
            });
        }
    }

    openAchievements() {
        if (!this.achievementsModal) return;
        this.renderAchievements();
        this.achievementsModal.classList.add('active');
        requestAnimationFrame(() => {
            if (this.modal && this.modal.activateModalFocusTrap) {
                this.modal.activateModalFocusTrap(this.achievementsModal);
            }
        });
    }

    closeAchievements() {
        if (this.achievementsModal) {
            this.modal?.releaseModalFocusTrap?.(this.achievementsModal);
            this.achievementsModal.classList.remove('active');
        }
    }

    renderAchievements() {
        if (!this.achievementsList) return;
        this.achievementsList.replaceChildren();

        const achievements = [
            { id: 'first-race', title: 'First Race', desc: 'Complete your first daily challenge race.', progress: 1, total: 1, unlocked: true },
            { id: 'speed-demon', title: 'Speed Demon', desc: 'Reach a top speed of 250 KPH.', progress: 210, total: 250, unlocked: false },
            { id: 'drift-king', title: 'Drift King', desc: 'Maintain a drift for 3 seconds.', progress: 1.5, total: 3, unlocked: false },
            { id: 'podium-finisher', title: 'Podium Finisher', desc: 'Finish in the Top 3 on any leaderboard.', progress: 0, total: 1, unlocked: false },
            { id: 'frequent-flyer', title: 'Frequent Flyer', desc: 'Spend a total of 10 seconds in the air.', progress: 4.2, total: 10, unlocked: false }
        ];

        achievements.forEach(ach => {
            const item = document.createElement('div');
            item.className = `achievement-item ${ach.unlocked ? 'is-unlocked' : 'is-locked'}`;
            
            const icon = document.createElement('div');
            icon.className = 'achievement-icon';
            icon.innerHTML = ach.unlocked ? '🏆' : '🔒';
            
            const info = document.createElement('div');
            info.className = 'achievement-info';
            
            const title = document.createElement('div');
            title.className = 'achievement-title';
            title.textContent = ach.title;
            
            const desc = document.createElement('div');
            desc.className = 'achievement-desc';
            desc.textContent = ach.desc;

            info.appendChild(title);
            info.appendChild(desc);

            const main = document.createElement('div');
            main.className = 'achievement-main';
            main.appendChild(icon);
            main.appendChild(info);

            const progress = document.createElement('div');
            progress.className = 'achievement-progress';

            const bar = document.createElement('div');
            bar.className = 'achievement-bar';
            const fill = document.createElement('div');
            fill.className = 'achievement-fill';
            fill.style.width = `${(ach.progress / ach.total) * 100}%`;
            bar.appendChild(fill);

            const label = document.createElement('div');
            label.className = 'achievement-label';
            label.textContent = `${Math.floor(ach.progress)} / ${ach.total}`;

            progress.appendChild(bar);
            progress.appendChild(label);

            item.appendChild(main);
            item.appendChild(progress);
            
            this.achievementsList.appendChild(item);
        });
    }
}
