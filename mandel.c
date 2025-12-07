// mandel.c
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

static int fbW = 0;
static int fbH = 0;
static uint8_t *framebuffer = 0;

void init_framebuffer(int w, int h)
{
    if (w <= 0 || h <= 0)
        return;

    if (framebuffer)
    {
        free(framebuffer);
        framebuffer = 0;
    }

    fbW = w;
    fbH = h;
    framebuffer = (uint8_t *)malloc((size_t)fbW * (size_t)fbH * 4);
}

uint8_t *get_framebuffer_ptr(void)
{
    return framebuffer;
}

static int in_cardioid_or_bulb(double x, double y)
{
    double yabs = (y >= 0.0) ? y : -y;

    double dx2 = x + 1.0;
    double dy2 = yabs;
    if (dx2 * dx2 + dy2 * dy2 < 0.0625)
    {
        return 1;
    }

    double dx = x - 0.25;
    double q = dx * dx + yabs * yabs;
    return q * (q + dx) < 0.25 * yabs * yabs;
}

static double mandel(double cx, double cy, int maxIter)
{
    double ay = (cy >= 0.0) ? cy : -cy;

    if (in_cardioid_or_bulb(cx, ay))
    {
        return maxIter;
    }

    double x = 0.0, y = 0.0;
    double xx = 0.0, yy = 0.0;
    int i = 0;

    while (xx + yy <= 4.0 && i < maxIter)
    {
        y = 2.0 * x * y + ay;
        x = xx - yy + cx;
        xx = x * x;
        yy = y * y;
        i++;
    }

    if (i >= maxIter)
    {
        return maxIter;
    }

    double mag = sqrt(xx + yy);
    return i + 1.0 - log(log(mag)) / log(2.0);
}

// Derive maxIter from zoom (softer, non-insane scaling)
static int auto_max_iter(double zoom)
{
    const int minIter = 80;   // base detail at full view
    const int maxIter = 6000; // hard cap
    const double K = 50.0;    // strength
    const double P = 1.25;    // exponent on log10(zoom)

    if (zoom < 1.0)
        zoom = 1.0;

    double logz = log10(zoom);
    if (logz < 1.0)
        logz = 1.0;

    double it = (double)minIter + K * pow(logz, P);

    if (it < minIter)
        it = minIter;
    if (it > maxIter)
        it = maxIter;

    return (int)(it + 0.5);
}

// Map iteration value to [0,1] including interior handling.
// fillInterior == 0 → interior black (hollow).
// fillInterior != 0 → interior white (solid).
static double normalized_escape(double t, int maxIter, int fillInterior)
{
    if (t >= (double)maxIter)
    {
        return fillInterior ? 1.0 : 0.0;
    }
    if (t <= 0.0)
    {
        return 0.0;
    }
    return t / (double)maxIter;
}

// Render a horizontal band y in [yStart, yEnd).
// cx, cy       : center in complex plane
// zoom         : zoom factor (1 = base view, >1 zoom in)
// scale        :
//    scale >= 1 : block mode, block ~ scale pixels
//    0 < scale < 1 : AA mode, samplesPerDim ~ 1/scale
// fillInterior : 0 = hollow (black interior), non-zero = filled (white interior)
void render_rows(double cx, double cy, double zoom, double scale,
                 int yStart, int yEnd, int fillInterior)
{
    if (!framebuffer || fbW <= 0 || fbH <= 0)
        return;

    if (zoom <= 0.0)
        zoom = 1.0;
    if (scale <= 0.0)
        scale = 1.0;

    if (yStart < 0)
        yStart = 0;
    if (yEnd > fbH)
        yEnd = fbH;
    if (yStart >= yEnd)
        return;

    int minDim = (fbW < fbH) ? fbW : fbH;
    if (minDim <= 0)
        return;

    double basePixelSize = 4.0 / (double)minDim;
    double pixelSize = basePixelSize / zoom;

    int maxIter = auto_max_iter(zoom);

    double halfW = 0.5 * (double)fbW;
    double halfH = 0.5 * (double)fbH;

    if (scale >= 1.0)
    {
        int block = (int)(scale + 0.5);
        if (block < 1)
            block = 1;

        for (int j = yStart; j < yEnd; j += block)
        {
            int bh = block;
            if (j + bh > yEnd)
                bh = yEnd - j;

            double center_j = (double)j + 0.5 * (double)bh;
            double y = cy + (center_j - halfH) * pixelSize;

            for (int i = 0; i < fbW; i += block)
            {
                int bw = block;
                if (i + bw > fbW)
                    bw = fbW - i;

                double center_i = (double)i + 0.5 * (double)bw;
                double x = cx + (center_i - halfW) * pixelSize;

                double t = mandel(x, y, maxIter);
                double n = normalized_escape(t, maxIter, fillInterior);

                if (n < 0.0)
                    n = 0.0;
                if (n > 1.0)
                    n = 1.0;

                uint8_t g = (uint8_t)(n * 255.0 + 0.5);

                for (int jj = 0; jj < bh; jj++)
                {
                    int ypix = j + jj;
                    size_t rowBase = (size_t)ypix * fbW;
                    for (int ii = 0; ii < bw; ii++)
                    {
                        int xpix = i + ii;
                        size_t idx = (rowBase + (size_t)xpix) * 4;
                        framebuffer[idx + 0] = g;
                        framebuffer[idx + 1] = g;
                        framebuffer[idx + 2] = g;
                        framebuffer[idx + 3] = 255;
                    }
                }
            }
        }
    }
    else
    {
        double invScale = 1.0 / scale;
        int samplesPerDim = (int)(invScale + 0.5);
        if (samplesPerDim < 1)
            samplesPerDim = 1;
        const int MAX_SAMPLES_PER_DIM = 8;
        if (samplesPerDim > MAX_SAMPLES_PER_DIM)
            samplesPerDim = MAX_SAMPLES_PER_DIM;

        int numSamples = samplesPerDim * samplesPerDim;

        for (int j = yStart; j < yEnd; j++)
        {
            double y0 = cy + (((double)j + 0.5) - halfH) * pixelSize;

            for (int i = 0; i < fbW; i++)
            {
                double x0 = cx + (((double)i + 0.5) - halfW) * pixelSize;

                double sum = 0.0;

                for (int sy = 0; sy < samplesPerDim; sy++)
                {
                    double fy = ((double)sy + 0.5) / (double)samplesPerDim;
                    double dy = (fy - 0.5) * pixelSize;
                    double y = y0 + dy;

                    for (int sx = 0; sx < samplesPerDim; sx++)
                    {
                        double fx = ((double)sx + 0.5) / (double)samplesPerDim;
                        double dx = (fx - 0.5) * pixelSize;
                        double x = x0 + dx;

                        double t = mandel(x, y, maxIter);
                        double n = normalized_escape(t, maxIter, fillInterior);

                        sum += n;
                    }
                }

                double avg = sum / (double)numSamples;
                if (avg < 0.0)
                    avg = 0.0;
                if (avg > 1.0)
                    avg = 1.0;

                uint8_t g = (uint8_t)(avg * 255.0 + 0.5);
                size_t idx = ((size_t)j * fbW + (size_t)i) * 4;
                framebuffer[idx + 0] = g;
                framebuffer[idx + 1] = g;
                framebuffer[idx + 2] = g;
                framebuffer[idx + 3] = 255;
            }
        }
    }
}

// Convenience: full-frame render (fallback)
void render_frame(double cx, double cy, double zoom, double scale, int fillInterior)
{
    render_rows(cx, cy, zoom, scale, 0, fbH, fillInterior);
}
