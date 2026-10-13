import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

const TAPS = 96;

/**
 * Blurs the actor and cuts it to a rounded rectangle in one pass.
 * Shell.BlurEffect can't be rounded and stops blurring under another effect.
 */
const RoundedBlur = GObject.registerClass(
class RoundedBlur extends Shell.GLSLEffect {
    override vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, 'uniform vec2 size;\nuniform float radius;\nuniform float blur;', `
            vec2 uv = cogl_tex_coord0_in.xy;
            vec4 sum = vec4(0.0);
            float total = 0.0;
            // Gaussian-weighted samples on a golden-angle spiral
            for (int i = 0; i < ${TAPS}; i++) {
                float r = sqrt((float(i) + 0.5) / ${TAPS}.0);
                float a = float(i) * 2.39996323;
                float w = exp(-2.0 * r * r);
                sum += texture2D(cogl_sampler0, uv + vec2(cos(a), sin(a)) * r * blur / size) * w;
                total += w;
            }
            vec2 q = abs(uv * size - size * 0.5) - (size * 0.5 - radius);
            cogl_color_out = sum / total * clamp(radius - length(max(q, 0.0)) + 0.5, 0.0, 1.0);
        `, true);
    }

    update(width: number, height: number, radius: number, blur: number) {
        this.set_uniform_float(this.get_uniform_location('size'), 2, [width, height]);
        this.set_uniform_float(this.get_uniform_location('radius'), 1, [radius]);
        this.set_uniform_float(this.get_uniform_location('blur'), 1, [blur]);
        this.queue_repaint();
    }
});

/**
 * A blurred copy of the windows and wallpaper behind it, with rounded corners
 * matching `shape`, placed behind it in the same parent. Shell.BlurEffect in BACKGROUND mode can't be rounded,
 * so this blurs a clone of the window group instead.
 */
export function createBlur(shape: St.Widget): St.Widget {
    // Bound to `shape` instead of sitting in a layout, where the full-stage clone would make it grow.
    const blur = new St.Widget({
        clip_to_allocation: true,
        constraints: new Clutter.BindConstraint({source: shape, coordinate: Clutter.BindCoordinate.ALL}),
    });
    const clone = new Clutter.Clone({source: global.window_group});
    blur.add_child(clone);
    const effect = new RoundedBlur();
    blur.add_effect(effect);

    blur.connect('notify::allocation', () => {
        const [x, y] = blur.get_transformed_position();
        clone.set_position(-x, -y);
        clone.set_size(global.stage.width, global.stage.height);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = shape.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        effect.update(blur.width, blur.height, radius, 24 * scale);
    });
    return blur;
}
