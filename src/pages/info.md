### Mandelbrought

It seems simple rules can and often will generate increadably complex systems. This is famussly demonstrated wia fractals. A simple function if mapped out can generate a shape with increadable complexity. A shape with a finite volume, but with a circumfrance thats infenetly long. Of theese fractals the mandelbrot set is perhaps the most famous fractal there is.

This set was first defined and drawn by Robert W. Brooks and Peter Matelski in 1978. It has later gained widespread recognition and awe becouse of its mathmatical richness and and increadable beauty.

This page randers the famous fractal on your machine. With this page you may zoom arbetrarely deep into the fractal and look at its deiffering aspects and regions.


The mandelbrought is computed with this simple looking formula:

$$
z_{n+1} = z_n^2 + c
$$

We define c as a complex number. Lets choose $c = -0.5125 + 0.5213i$ as this is the value of our jula-set the moment we load the page. We always start with $z_0 = 0$. The formula then gives us:

$$
z_{1} = 0^2 - 0.5125 + 0.5213i
$$
$$
z_{2} = (-0.5125 + 0.5213i)² -0.5125 + 0.5213i
$$
$$
z_{3} = (-0.5216 - 0.0128i)² -0.5125 + 0.5213i
$$
and so on...

If we map all values of z onto the complex plane, we see a shape. This shape is our julia set. For this perticular value of c it looks like the small image in the julia-set viewer when you first load the page. This shape is itself facentanting and beutifull, and represents a traversal of the plane.

We may now move he julia-set cursour around. The shape will morph and change depending on the starting possition. If we are to move the julia-cursor well within the mandelbrought set, the jula-set becomes simple and solid. If we move it outside the mandelbrought the julia set becomes sparce and disconected. This is how the mandelbrugh itself is calculated.

For any value $c$ that produces an unconnected julia-set we color that value of c balck in the complex plane. For any value of $c$ that produces a julia-set wich is compleatly connected, we collor that value blue in the complex plane. If we do this for every pixel on our screen, we get the all to famous mandelbrought set. 

In this render i have taken some common artistic libberties with removing the solid infill and initially only colloring the border between the set and its sorroundings. The saturation of color is determined from how connected/disconected the jula-sets in that region is. You may choose to recollor the infill if you want.

A more mathmatical way to figure out if the julia-sets are connected is to look att their limit. If c goes to inifinnety then the set is disconnected. It is proven that is c ever escapes a radius of 2 it will always diverge to infinety. Therefore we may test n iterations untill c falls outside r=2. N is choosen via the iterations input. For n=200 we try 200 iterations of c and if it still after 200 iterations does not fall ouside of r = 2 then we assume the julia-set to be continious. However as you may discover leaving n at 200 might not be anough to accuretly exsamin small subsections of mandelbrought, and you may need to increese it further to get an accureate picture.

Mandelbrought itself is mathematicly rich. Looking at subsections of the set produces recognizable and usefull mathmatical phenomena. Looking at the real numberline within the set and how many iterations it takes to prove continiusness of julia sets gives uss the bifurcation diagram of the logistic map. Also complexity of fractals makes them usefull in some cryptographic prosesses. We may also analyze the fractal in other ways. for example we may choose to color baced on number of visists c has to the same place thater then escape iterattions. We then get the buddah set as you also may explore.

One may start to question. Did we invent the mandelbrought set by analyzing a function in a spesific way, or did we discover the shape as an emergent phenomena of the function itself?