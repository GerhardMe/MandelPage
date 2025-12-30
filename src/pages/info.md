# Mandelbrot set

It seems simple rules can and often will generate incredibly complex systems. This is famously demonstrated via fractals. A simple function if mapped out can generate a shape with incredible complexity. A shape with a finite area, but with a boundary that’s infinitely long. Of these fractals the Mandelbrot set is perhaps the most famous fractal there is.

This set was first defined and drawn by Robert W. Brooks and Peter Matelski in 1978. It has later gained widespread recognition and awe because of its mathematical richness and incredible beauty.

This page renders the famous fractal on your machine. With this page you may zoom arbitrarily deep into the fractal and look at its differing aspects and regions.

The Mandelbrot is computed with this simple looking formula:

$$
z_{n+1} = z_n^2 + c
$$

We define \(c\) as a complex number. Let’s choose \(c = -0.5125 + 0.5213i\) as this is the value of our Julia-set the moment we load the page. We always start with \(z_0 = 0\). The formula then gives us:

$$
z_{1} = 0^2 - 0.5125 + 0.5213i
$$
$$
z_{2} = (-0.5125 + 0.5213i)^2 - 0.5125 + 0.5213i
$$
$$
z_{3} = (-0.5216 - 0.0128i)^2 - 0.5125 + 0.5213i
$$
$$
\text{and so on...}
$$

If we map all values of \(z\) onto the complex plane, we see a shape. This shape is our Julia set. For this particular value of \(c\) it looks like the small image in the Julia-set viewer when you first load the page. This shape is itself fascinating and beautiful, and represents a traversal of the plane.

We may now move the Julia-set cursor around. The shape will morph and change depending on the starting position. If we are to move the Julia-cursor well within the Mandelbrot set, the Julia-set becomes simple and solid. If we move it outside the Mandelbrot the Julia-set becomes sparse and disconnected. This is how the Mandelbrot itself is calculated.

For any value \(c\) that produces a disconnected Julia-set we color it black in the complex plane. For any value of \(c\) that produces a Julia-set which is completely connected, we color it blue in the complex plane. If we do this for every pixel on our screen, we get the all-too-famous Mandelbrot set, where the inside of set is bule and outside is black.

In this render I have taken some common artistic liberties. Fistly we color according to how disconnected the jula-sets are and not just eather or. Also i have choosen to remove the solid infill and initially only coloring the border between the set and its surroundings. You may choose to recolor the infill as you want.

A more mathematical way to figure out if the Julia-sets are connected is to look at their limit. If \(z\) goes to infinity then the set is disconnected. It is proven that if \(z\) ever escapes a radius of 2 it will always diverge to infinity. Therefore we may test \(n\) iterations until \(z\) falls outside \(r = 2\). \(n\) is chosen via the iterations input. For \(n = 200\) we try 200 iterations of \(z\) and if it still after 200 iterations does not fall outside of \(r = 2\) then we assume the Julia-set to be continuous. However as you may discover leaving \(n\) at 200 might not be enough to accurately examine small subsections of Mandelbrot, and you may need to increase it further to get an accurate picture.

Mandelbrot itself is mathematically rich. Looking at subsections of the set produces recognizable and useful mathematical phenomena. Looking at the real number line within the set and how many iterations it takes to prove continuity of Julia-sets gives us the bifurcation diagram of the logistic map. Also complexity of fractals makes them useful in some cryptographic processes. We may also analyze the fractal in other ways. For example we may choose to color based on number of visits \(z\) has to the same place rather than escape iterations. We then get the Buddhabrot, antother beutiull shape.

One may start to question. Did we invent the Mandelbrot set by analyzing a function in a specific way, or did we discover the shape as an emergent phenomenon of the function itself? Perhaps the function is itself a way of analyzing the complex plane. If so, what is not emergent?
