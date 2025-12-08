### Mandelbrought

It seems simple rules can and often will generate increadably complex systems. This is famussly demonstrated wia fractals. A simple function if mapped out can generate a shape with infenete complexity. A shape with finite volume, but infenete circumfrance. The mandelbrot set is perhaps the most famous fractal there is.








$$
z_{n+1} = z_n^2 + c
$$

We define c as a complex number. Lets choose $c = -0.5125 + 0.5213i$ for this exsample. and we alsways start with $z_0 = 0$. The formula then gives us:

$$
z_{1} = 0^2 - 0.5125 + 0.5213i
$$
$$
z_{2} = (-0.5125 + 0.5213i)² -0.5125 + 0.5213i
$$
$$
z_{3} = (-0.5216 - 0.0128i)² -0.5125 + 0.5213i
$$
and so on and so on...

If we map all values of z onto the complex plane, we see a shape. This shape is called a julia set. A Julia set has a finite volume, but an infenete circonferance. For this perticular value of c it looks like this:

![[julia set.png]]

This infenetly complex shape is in itself interesting, but the complexity of this simple formula does not end here. If we choose another value for c we will get another julia set. Lets define $c = 0.285 + 0.01i$. The shape we now gets looks like this:

![[Pasted image 20251111155220.png]]

One of the many diffences between the 2 shapes is that the second shape is discontinius. Lets take all possible values of c and splitt them into 2 groups. One group cointains all continius shapes, and the other all discontinius shapes. If we now paint all values for c in the complex plane acourding to what group it belongs to, we get this shape.

![[Pasted image 20251111155753.png]]
*If you have never heard or seen the mandlebrought before i recomend checking it out. its mesmorizingly beutifull once you zoom in on its infenetly complex border.

This is the all to famous mandelbrought set. Note, that we simply analyzing and orgenizing our data. We are still only looking at the first simple formula, but we are looking at its outputt in a way where we get this shape. We could have choosen to analyze the julia sets in another way. Fro exsample we could have mapped them with respect to their volume or some compleatly other caracteristic, Thoose ways of looking at our data would have given other shapes with other charateristics.

Note also, that to divide the julia sets into 2 catagories on whether they are continous or not is mathematicly equivelent as dividing our function into 2 groups of weather they diverge to infinety or not. 

One may start to question. Did we invent the mandelbrought set by analyzing the function in a certain way, or did we discover the shape as an emergent phenomena of the function itself?