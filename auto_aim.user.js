// ==UserScript==
// @name         High Noon Auto-Aim & Auto-Shoot
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Injects auto-aim script directly into page context
// @author       You
// @match        https://high-noon-reborn.web.app/*
// @match        http://localhost:8080/*
// @match        http://127.0.0.1:8080/*
// @icon         https://high-noon-reborn.web.app/favicon.ico
// @grant        none
// @run-at       document-end
// ==/UserScript==

// This userscript creates a <script> tag that runs INSIDE the page context,
// bypassing the userscript sandbox entirely. This gives us full access to
// window.HN and the game engine.

const code = `
(function() {
    'use strict';
    
    console.log('%c🔫 Auto-Aim INJECTED', 'background: #c0392b; color: #fff; font-size: 16px; padding: 4px;');
    
    const SETTINGS = { autoAim: true, autoShoot: true, autoReload: true, debug: true };
    
    // Keyboard toggles
    document.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        if (k === 'a') { SETTINGS.autoAim = !SETTINGS.autoAim; toast('Aim: ' + (SETTINGS.autoAim ? 'ON' : 'OFF')); }
        if (k === 's') { SETTINGS.autoShoot = !SETTINGS.autoShoot; toast('Shoot: ' + (SETTINGS.autoShoot ? 'ON' : 'OFF')); }
        if (k === 'd') { SETTINGS.autoReload = !SETTINGS.autoReload; toast('Reload: ' + (SETTINGS.autoReload ? 'ON' : 'OFF')); }
        if (k === 'f') { SETTINGS.debug = !SETTINGS.debug; const o = document.getElementById('hn-debug'); if (o) o.style.display = SETTINGS.debug ? 'block' : 'none'; toast('Debug: ' + (SETTINGS.debug ? 'ON' : 'OFF')); }
    });
    
    function getEngine() {
        try { return window.HN.services.ui.gameEngine; } catch(e) { return null; }
    }
    
    // Override the gyro handler to prevent it from fighting our aim
    function patchGyro(engine) {
        if (engine._hnPatched) return;
        engine._hnPatched = true;
        console.log('🔫 Gyro patched');
        
        engine.handleOrientation = function(beta, gamma) {
            if (this.baseBeta === null) {
                this.baseBeta = beta;
                this.baseGamma = gamma;
                this.filteredBeta = beta;
                this.filteredGamma = gamma;
            }
            this.filteredBeta += 0.15 * (beta - this.filteredBeta);
            this.filteredGamma += 0.15 * (gamma - this.filteredGamma);
            
            // Keep reload detection working
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
                            this.reloadState.lastBulletTime = 0;
                            this.reloadState.bulletsLoaded = 0;
                            if (this.renderer) this.renderer.updateAmmoDisplay(this.ammo, false);
                        }
                    }, this.weaponStats ? this.weaponStats.reloadDelay : 500);
                } else {
                    this.reloadState.active = false;
                    if (this.renderer) this.renderer.completeReload();
                }
            }
            
            // DON'T set targetWorldX/Y here - we do that in our loop
        };
    }
    
    let aimInterval = null, shootInterval = null, reloadInterval = null;
    
    function startLoops() {
        if (aimInterval) return;
        
        // Goal: This should sync on next rAF tick so canvas renders correctly
        aimInterval = setInterval(function() {
            const eng = getEngine();
            if (!eng || !SETTINGS.autoAim || eng.state !== 1 || eng.enemyHP <= 0) return;
            
            const maxX = eng.maxWorldX || 200;
            const maxY = eng.maxWorldY || 200;
            const tx = Math.max(-maxX, Math.min(maxX, eng.enemyX || 0));
            const ty = -55;
            
            eng.targetWorldX = tx;
            eng.targetWorldY = ty;
            
            // Direct offset manipulation
            const smooth = 0.3;
            eng.worldOffsetX += (tx - eng.worldOffsetX) * smooth;
            eng.worldOffsetY += (ty - eng.worldOffsetY) * smooth;
            
            // Force renderer update
            if (eng.renderer && eng.renderer.updateWorld) {
                eng.renderer.updateWorld(eng.worldOffsetX, eng.worldOffsetY, eng.impactX || 0, eng.impactY || 0, eng.enemyX);
            }
        }, 16);
        
        shootInterval = setInterval(function() {
            const eng = getEngine();
            if (!eng || !SETTINGS.autoShoot || eng.state !== 1) return;
            if (eng.ammo <= 0) return;
            if (eng.reloadState && (eng.reloadState.active || eng.reloadState.completing)) return;
            if (eng.isReloading || !eng.canShootLocal) return;
            const cd = eng.weaponStats ? eng.weaponStats.shotCooldown : 400;
            if (Date.now() - eng.lastPlayerShotTime < cd) return;
            eng.shoot();
        }, 60);
        
        reloadInterval = setInterval(function() {
            const eng = getEngine();
            if (!eng || !SETTINGS.autoReload || eng.state !== 1) return;
            const rl = eng.reloadState;
            const busy = eng.isReloading || (rl && (rl.active || rl.completing));
            
            if (eng.ammo <= 0 && !busy) {
                if (rl && !rl.active) {
                    rl.active = true;
                    rl.bulletsLoaded = eng.ammo;
                    rl.startTime = Date.now();
                    if (eng.renderer) {
                        eng.renderer.hideHolsterPrompt();
                        eng.renderer.startReloadSequence(eng.ammo);
                    }
                }
            }
            
            if (rl && rl.active && !rl.completing && typeof eng.handleReloadTap === 'function') {
                eng.handleReloadTap();
            }
        }, 30);
        
        // Draw watcher
        setInterval(function() {
            const eng = getEngine();
            if (!eng || eng.drawTime) return;
            const btn = document.getElementById('draw-start-btn');
            if (btn && btn.style.display !== 'none' && typeof eng.onDrawClick === 'function') {
                eng.onDrawClick();
            }
        }, 100);
    }
    
    // Debug overlay
    function createDebug() {
        if (document.getElementById('hn-debug')) return;
        var d = document.createElement('div');
        d.id = 'hn-debug';
        d.innerHTML = '<b style="color:#f5d27a">🔫 v3</b><div id="hd1">-</div><div id="hd2">-</div><div id="hd3">-</div><div id="hd4">-</div><div id="hd5">-</div><div id="hd6">-</div>';
        d.style.cssText = 'position:fixed;top:60px;right:10px;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:12px;padding:10px;border-radius:6px;z-index:999999;min-width:280px;pointer-events:none;border:1px solid #0f0;';
        document.body.appendChild(d);
    }
    
    function updateDebug() {
        var eng = getEngine(); if (!eng) return;
        createDebug();
        document.getElementById('hd1').textContent = 'State:' + (['HOME','PLAY','DEAD'][eng.state]||eng.state) + ' CanShoot:' + eng.canShootLocal + ' Draw:' + (eng.drawTime?'Y':'N');
        document.getElementById('hd2').textContent = 'Ammo:' + eng.ammo + '/' + (eng.weaponStats?eng.weaponStats.ammo:'?') + ' Reload:' + (eng.reloadState?.active?'A':eng.reloadState?.completing?'C':'I');
        document.getElementById('hd3').textContent = 'EnemyX:' + (eng.enemyX||0).toFixed(1) + ' HP:' + eng.enemyHP + '/' + eng.enemyMaxHP;
        document.getElementById('hd4').textContent = 'Tgt:' + eng.targetWorldX.toFixed(1) + ',' + eng.targetWorldY.toFixed(1);
        document.getElementById('hd5').textContent = 'Off:' + eng.worldOffsetX.toFixed(1) + ',' + eng.worldOffsetY.toFixed(1);
        document.getElementById('hd6').textContent = 'A:' + (SETTINGS.autoAim?'Y':'N') + ' S:' + (SETTINGS.autoShoot?'Y':'N') + ' R:' + (SETTINGS.autoReload?'Y':'N');
    }
    
    function toast(m) {
        var t = document.getElementById('hn-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'hn-toast';
            t.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.85);color:#f5d27a;font-family:monospace;font-size:16px;padding:8px 20px;border-radius:6px;z-index:999999;border:1px solid #e67e22;pointer-events:none;';
            document.body.appendChild(t);
        }
        t.textContent = m;
        t.style.opacity = '1';
        clearTimeout(t._h);
        t._h = setTimeout(function() { t.style.opacity = '0'; }, 2000);
    }
    
    // Wait for game engine, patch gyro, start loops
    function waitForGame() {
        var eng = getEngine();
        if (eng && window.HN && window.HN.mounts) {
            console.log('🔫 Engine found! Patching...');
            patchGyro(eng);
            startLoops();
            createDebug();
            setInterval(updateDebug, 200);
            toast('Auto-Aim ready - A/S/D/F');
            
            // DIRECT DOM APPROACH: also force background to follow enemy position
            setInterval(function() {
                if (!SETTINGS.autoAim) return;
                var bg = document.getElementById('background');
                var enemyEl = document.getElementById('enemy');
                if (!bg || !enemyEl) return;
                
                var eng2 = getEngine();
                if (!eng2 || eng2.state !== 1) return;
                
                // Force the game to process our target
                var maxX = eng2.maxWorldX || 200;
                var targetX = Math.max(-maxX, Math.min(maxX, eng2.enemyX || 0));
                var targetY = -55;
                
                // Override everything - set target, offset, and force render
                eng2.targetWorldX = targetX;
                eng2.targetWorldY = targetY;
                eng2.worldOffsetX = targetX;
                eng2.worldOffsetY = targetY;
                
                // DIRECT DOM manipulation as ultimate fallback
                var impactX = eng2.impactX || 0;
                var impactY = eng2.impactY || 0;
                var offsetX = targetX + impactX;
                var offsetY = targetY + impactY;
                
                bg.style.transform = 'translate(calc(-50% + ' + offsetX + 'px), calc(-50% + ' + offsetY + 'px))';
                
                // Move enemy too
                var vhOff = 5; // ENEMY_Y_OFFSET_VH
                enemyEl.style.left = 'calc(50% + ' + (eng2.enemyX + offsetX) + 'px)';
                enemyEl.style.top = 'calc(' + (50 + vhOff) + '% + ' + offsetY + 'px)';
            }, 16);
            
            return;
        }
        setTimeout(waitForGame, 500);
    }
    
    setTimeout(waitForGame, 3000);
})();
`;

// Create script element and inject into page
const script = document.createElement('script');
script.textContent = code;
document.documentElement.appendChild(script);
script.remove();
