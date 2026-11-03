# Ag Adatom Random Walk on Ag(111)

Interactive Monte Carlo simulation of a single silver adatom performing thermally activated hops on a triangular lattice of hollow sites on an Ag(111) surface.

**Live demo:** [https://detlef.diesing.pro/random-walk/](https://detlef.diesing.pro/random-walk/?seed=1847528449)

## Scientific context

The model implements a classroom-style Monte Carlo simulation of surface diffusion.  
It is based on:

> J.P. Meyburg & Detlef Diesing, *J. Chem. Educ.* **2017**, 94, 1225–1231.  
> [https://doi.org/10.1021/acs.jchemed.6b01008](https://doi.org/10.1021/acs.jchemed.6b01008)

## Features

- Thermally activated hops on a triangular lattice (six equivalent nearest-neighbor directions)
- Periodic boundary conditions
- Visual trail (one disk per visited site; revisits change color and opacity)
- Layer B / Layer C distinction
- Controls: Play, One hop, Reset, New run
- Export: Save SVG, Download CSV

## How to run locally

1. Clone the repository
2. Open `index.html` in a modern browser  
   (or serve the folder with any simple static server)

## Notes

- Start position is marked by a white disk with a horizontal bar.
- Current position is indicated by a vertical bar.
- For terraces larger than 100×100, layers are drawn as filled parallelograms with atoms only on the rim.
