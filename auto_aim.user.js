// ==UserScript==
// @name         High Noon Auto-Aim iOS
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Auto-aim, auto-shoot, auto-reload for iOS Safari
// @match        https://high-noon-reborn.web.app/*
// @icon         https://high-noon-reborn.web.app/favicon.ico
// @grant        none
// @run-at       document-end
// ==/UserScript==

// Inject script into page context (works on iOS Userscripts, Tampermonkey, Greasemonkey)
const code = `
(function() {
    'use strict';
    
    console.log('🔫 HN Auto-Aim iOS');
    
    const SETTINGS = { aim: true, shoot: true, reload: true };
    
    // Toggle with triple-tap on the screen
    let taps = 0, tapTimer = null;
    document.addEventListener('touchstart', (e) => {
        taps++;
        if (taps === 3) {
            SETTINGS.aim = !SETTINGS.aim;
            toast('Auto-Aim: ' + (SETTINGS.aim ? 'ON' : 'OFF'));
            taps = 0;
            clearTimeout(tapTimer);
            return;
        }
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => { taps = 0; }, 500);
    });
    
    function getEngine() {
        try { return window.HN.services.ui.gameEngine; } catch(e) { return null; }
    }
    
    // ====== OVERRIDE GYRO: Make crosshair lock onto enemy head ======
    function patchGyro(eng) {
        if (eng.__hnPatched) return;
        eng.__hnPatched = true;
        console.log('🔫 Gyro → Head lock');
        
        // Save original for manual aiming if turned off
        eng.__origHandleOrientation = eng.handleOrientation.bind(eng);
        
        eng.handleOrientation = function(beta, gamma) {
            // Track base for recenter
            if (this.baseBeta === null) {
                this.baseBeta = beta;
                this.baseGamma = gamma;
                this.filteredBeta = beta;
                this.filteredGamma = gamma;
            }
            this.filteredBeta += 0.15 * (beta - this.filteredBeta);
            this.filteredGamma += 0.15 * (gamma - this.filteredGamma);
            
            // --- RELOAD: Keep tilt-to-reload working ---
            const tilt = beta - this.baseBeta;
            if (tilt < -30 && !this.reloadState.active && !this.reloadState.completing && this.ammo < (this.weaponStats ? this.weaponStats.ammo : 6)) {
                if (this.renderer) this.renderer.hideHolsterPrompt();
                this.reloadState.active = true;
                this.reloadState.bulletsLoaded = this.ammo;
                this.reloadState.startTime = Date.now();
                if (this.renderer) this.renderer.startReloadSequence(this.ammo);
                if (this.audioManager) this.audioManager.play("reload_start");
            } else if (tilt >= -20 && this.reloadState.active && !this.reloadState.completing) {
                if (this.reloadState.bulletsLoaded > 0) {
                    this.reloadState.completing = true;
                    this.battleStats.reloadCount++;
                    this.battleStats.reloadTimeTotal += Date.now() - this.reloadState.startTime;
                    if (this.renderer) this.renderer.completeReload();
                    if (this.audioManager) this.audioManager.play("reload_finish");
                    setTimeout(() => {
                        if (this.state !== 2) {
                            this.ammo = this.reloadState.bulletsLoaded;
                            this.reloadState.active = false;
                            this.reloadState.completing = false;
                            this.reloadState.bulletsLoaded = 0;
                            if (this.renderer) this.renderer.updateAmmoDisplay(this.ammo, false);
                        }
                    }, this.weaponStats ? this.weaponStats.reloadDelay : 500);
                } else {
                    this.reloadState.active = false;
                    if (this.renderer) this.renderer.completeReload();
                }
            }
            
            // --- AIM: Lock onto enemy head ---
            if (SETTINGS.aim && this.state === 1 && this.enemyHP > 0) {
                const maxX = this.maxWorldX || 200;
                const maxY = this.maxWorldY || 200;
                const targetX = Math.max(-maxX, Math.min(maxX, this.enemyX || 0));
                const targetY = -55;
                
                // Set target instantly (game loop will smooth toward it)
                this.targetWorldX = targetX;
                this.targetWorldY = targetY;
            }
            // If auto-aim is OFF, fall back to gyro aiming
            else if (!SETTINGS.aim && this.__origHandleOrientation) {
                // Add small dead-zone so it doesn't drift
                let s = 0, a = 0;
                const dz = 1.5;
                s = Math.abs(beta - this.baseBeta) < dz ? 0 : (beta - this.baseBeta) - Math.sign(beta - this.baseBeta) * dz;
                a = Math.abs(gamma - this.baseGamma) < dz ? 0 : (gamma - this.baseGamma) - Math.sign(gamma - this.baseGamma) * dz;
                const sens = 3 * (this.sensitivity || 1);
                this.targetWorldX = (this.invertX ? a : -a) * sens;
                this.targetWorldY = (this.invertY ? -s : s) * sens;
            }
        };
    }
    
    // ====== AUTO SHOOT ======
    let lastShot = 0;
    function autoShoot() {
        const eng = getEngine();
        if (!eng || !SETTINGS.shoot || eng.state !== 1) return;
        if (eng.ammo <= 0) return;
        if (eng.reloadState && (eng.reloadState.active || eng.reloadState.completing)) return;
        if (eng.isReloading || !eng.canShootLocal) return;
        const cd = eng.weaponStats ? eng.weaponStats.shotCooldown : 400;
        if (Date.now() - eng.lastPlayerShotTime < cd) return;
        if (Date.now() - lastShot < 100) return;
        lastShot = Date.now();
        eng.shoot();
    }
    
    // ====== AUTO RELOAD ======
    function autoReload() {
        const eng = getEngine();
        if (!eng || !SETTINGS.reload || eng.state !== 1) return;
        const rl = eng.reloadState;
        const busy = eng.isReloading || (rl && (rl.active || rl.completing));
        
        if (eng.ammo <= 0 && !busy) {
            // Trigger reload by calling handleReloadTap (simulates tapping the screen during reload)
            eng.handleReloadTap();
        }
        if (rl && rl.active && !rl.completing && typeof eng.handleReloadTap === 'function') {
            eng.handleReloadTap();
        }
    }
    
    // ====== AUTO DRAW ======
    function autoDraw() {
        const eng = getEngine();
        if (!eng || eng.drawTime) return;
        const btn = document.getElementById('draw-start-btn');
        if (btn && btn.style.display !== 'none' && typeof eng.onDrawClick === 'function') {
            eng.onDrawClick();
        }
    }
    
    // ====== MAIN LOOP ======
    setInterval(function() {
        const eng = getEngine();
        if (!eng) return;
        autoDraw();
        autoShoot();
        autoReload();
        updateDebug(eng);
    }, 30);
    
    // ====== DEBUG ======
    function createDebug() {
        if (document.getElementById('hn-debug')) return;
        const d = document.createElement('div');
        d.id = 'hn-debug';
        d.innerHTML = '<div id="hd1">-</div><div id="hd2">-</div><div id="hd3">-</div><div id="hd4">-</div>';
        d.style.cssText = 'position:fixed;bottom:50px;left:5px;background:rgba(0,0,0,0.8);color:#0f0;font-family:monospace;font-size:10px;padding:4px 8px;border-radius:4px;z-index:999999;pointer-events:none;border:1px solid #0f0;';
        document.body.appendChild(d);
    }
    function updateDebug(eng) {
        if (!eng) return;
        createDebug();
        document.getElementById('hd1').textContent = 'Aim:'+(SETTINGS.aim?'Y':'N')+' Shoot:'+(SETTINGS.shoot?'Y':'N')+' Reload:'+(SETTINGS.reload?'Y':'N');
        document.getElementById('hd2').textContent = 'Ammo:'+eng.ammo+'/'+(eng.weaponStats?eng.weaponStats.ammo:'?');
        document.getElementById('hd3').textContent = 'HP:'+eng.enemyHP+' X:'+(eng.enemyX||0).toFixed(0);
        document.getElementById('hd4').textContent = 'Tgt:'+eng.targetWorldX.toFixed(0)+','+eng.targetWorldY.toFixed(0);
    }
    
    function toast(m) {
        var t = document.getElementById('hn-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'hn-toast';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#f5d27a;font-family:monospace;font-size:14px;padding:6px 16px;border-radius:6px;z-index:999999;border:1px solid #e67e22;pointer-events:none;';
            document.body.appendChild(t);
        }
        t.textContent = m; t.style.opacity = '1';
        clearTimeout(t._h); t._h = setTimeout(function(){ t.style.opacity = '0'; }, 2000);
    }
    
    // ====== START ======
    function start() {
        const eng = getEngine();
        if (eng && window.HN && window.HN.mounts) {
            console.log('🔫 Starting iOS auto-aim');
            patchGyro(eng);
            createDebug();
            toast('HN Auto ready - triple-tap to toggle');
            return;
        }
        setTimeout(start, 500);
    }
    setTimeout(start, 3000);
})();
`;

const s = document.createElement('script');
s.textContent = code;
document.documentElement.appendChild(s);
s.remove();