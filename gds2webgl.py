#!/usr/bin/env python3

import base64
import argparse
import colorsys

import numpy as np
import gdspy
import pyclipper
import mapbox_earcut as earcut


def area_of_poly(poly):
    '''
    Returns: The area enclosed by given polygon.
    Area is positive, if polygon points are ordered CCW.
    '''
    area = 0
    for j in range(len(poly)):
        x1, y1 = poly[j-1]
        x2, y2 = poly[j]
        area += (x1-x2)*(y1+y2)
    return area / 2


def edge_normals(poly):
    normals = np.zeros((len(poly), 2))
    for i in range(len(poly)):
        x1, y1 = poly[i]
        x2, y2 = poly[i+1] if i+1 < len(poly) else poly[0]
        if y1 == y2:
            normals[i, 1] = 1 if x1 > x2 else -1
        elif x1 == x2:
            normals[i, 0] = 1 if y1 < y2 else -1
    return normals


def grow_ring(ring, factor, offset):
    normals = edge_normals(ring)
    gpoly = np.zeros((len(ring), 2), dtype='int32')
    for i in range(len(ring)):
        gpoly[i] = (ring[i] * factor).round() + (normals[i] + normals[i-1]) * offset
    return gpoly


def grow_polys(polys, factor, offset=0):
    gpolys = []
    for poly in polys:
        if type(poly) is list:
            gpoly = [grow_ring(poly[0], factor, offset)]  # grow outer contours
            for p in poly[1:]:
                gpoly.append(grow_ring(p, factor, -offset))  # shrink holes
            gpolys.append(gpoly)
        else:
            gpolys.append(grow_ring(poly, factor, offset))
    return gpolys


def translate_polys(polys, xyoffset):
    gpolys = []
    for poly in polys:
        if type(poly) is list:
            gpolys.append([np.asarray(p + xyoffset, dtype='int32') for p in poly])
        else:
            gpolys.append(np.asarray(poly + xyoffset, dtype='int32'))
    return gpolys


def union_polys(polys):
    '''
    returns a list of lists of polygon points.
    First member of each list is an outer contour,
    the remaining members are holes.
    '''
    pc = pyclipper.Pyclipper()
    pc.AddPaths(polys, pyclipper.PT_SUBJECT, True)
    union = pc.Execute2(pyclipper.CT_UNION, pyclipper.PFT_POSITIVE, pyclipper.PFT_POSITIVE)
    
    def collect_outers_and_holes(root_node, result=None):
        if result is None:
            result = []
        for n in root_node.Childs:
            assert n.IsHole == False
            outer_and_holes = [np.asarray(n.Contour)]
            if len(n.Childs) > 0:
                for c in n.Childs:
                    assert c.IsHole
                    outer_and_holes.append(np.asarray(c.Contour))
                    if len(c.Childs) > 0:
                        collect_outers_and_holes(c, result)
            result.append(outer_and_holes)
        return result
                        
    return collect_outers_and_holes(union)


def triangulate(poly):
    rings=[]
    s = 0
    for p in poly:
        s += len(p)
        rings.append(s)
    rings = np.asarray(rings, dtype='int32')
    points = np.vstack(poly)
    return earcut.triangulate_int32(points, rings)


def bvlq2s_encode(ary):
    encoded = [0]
    batch_head = 0
    batch_tail = []
    batch_size = 0
    for v in ary:
        batch_head <<= 1
        if v < 2**7 and v > -(2**7-1):
            batch_tail.append(v & 0xff)
        elif v < 2**15 and v > -(2**15-1):
            batch_tail.append((v>>8) & 0xff)
            batch_tail.append(v & 0xff)
            batch_head |= 1
        else:
            raise ValueError(f"Out of range: {v}")
        batch_size += 1
        if batch_size == 8:
            encoded.append(batch_head)
            encoded += batch_tail
            batch_size = 0
            batch_head = 0
            batch_tail = []
    if batch_size > 0:
        batch_head <<= 8-batch_size
        encoded.append(batch_head)
        encoded += batch_tail
    return bytes(encoded)


def bvlq4s_encode(ary):
    encoded = [1]
    batch_head = 0
    batch_tail = []
    batch_size = 0
    for v in ary:
        batch_head <<= 2
        if v < 2**7 and v > -(2**7-1):
            batch_tail.append(v & 0xff)
        elif v < 2**15 and v > -(2**15-1):
            batch_tail.append((v>>8) & 0xff)
            batch_tail.append(v & 0xff)
            batch_head |= 1
        elif v < 2**23 and v > -(2**23-1):
            batch_tail.append((v>>16) & 0xff)
            batch_tail.append((v>>8) & 0xff)
            batch_tail.append(v & 0xff)
            batch_head |= 2
        elif v < 2**31 and v > -(2**31-1):
            batch_tail.append((v>>24) & 0xff)
            batch_tail.append((v>>16) & 0xff)
            batch_tail.append((v>>8) & 0xff)
            batch_tail.append(v & 0xff)
            batch_head |= 3
        else:
            raise ValueError(f"Out of range: {v}")
        batch_size += 1
        if batch_size == 4:
            encoded.append(batch_head)
            encoded += batch_tail
            batch_size = 0
            batch_head = 0
            batch_tail = []
    if batch_size > 0:
        batch_head <<= 8-(batch_size*2)
        encoded.append(batch_head)
        encoded += batch_tail
    return bytes(encoded)


class Layer:
    def __init__(self, name, layer_datatype, elevation=0, thickness=0, color=(0,1,1)):
        self.name = name
        self.layer_datatype = layer_datatype
        self.elevation = elevation
        self.thickness = thickness
        self.color = color
        self.scale = None
        self.bbox = None
        self.gds_polys = []
        self._union_polys = []
        self._triangles = []
        self._points_count = 0
        self._triangles_points_count = 0
        self.xy_range = [0, 0]

    def set_scale_and_bbox(self, gdslib, topcell):
        self.scale = gdslib.unit / gdslib.precision
        self.bbox = np.asarray((topcell.get_bounding_box() * self.scale).round(), dtype='int32')
        self.xy_range = list(self.bbox[1]-self.bbox[0])

    def add_gds_polys(self, gdslib, topcell=None):
        '''
        Adds all polygons with matching layer and datatype to self.gds_polys.
        All hierarchical cells are de-referenced.
        The points in each polygon are ordered CCW.
        The x and y coordinates are integer as stored in GDS.
        '''
        if topcell is None:
            topcell = gdslib.top_level()[0]
        if self.bbox is None:
            self.set_scale_and_bbox(gdslib, topcell)
        
        polys = [(p.polygons[0] * self.scale).round() 
                    for p in topcell.polygons 
                    if p.layers[0] == self.layer_datatype[0] and p.datatypes[0] == self.layer_datatype[1]]
        for r in topcell.references:
            rpolys = r.get_polygons(by_spec=True)
            if self.layer_datatype in rpolys:
                polys += [(rp * self.scale).round() for rp in rpolys[self.layer_datatype]]
        self.gds_polys += [np.asarray(p if area_of_poly(p) > 0 else p[::-1], dtype='int32') for p in polys]
        self._union_polys = None
        self._triangles = None

    @property
    def union_polys(self):
        if len(self.gds_polys) == 0:
            self._union_polys = []
        if self._union_polys is not None:
            return self._union_polys

        # union operation. grow polys a little to ensure merging of touching polys.    
        polys = grow_polys(self.gds_polys, 10, 1)  
        polys = union_polys(polys)
        polys = grow_polys(polys, 0.1)

        # move lower left corner to (0,0)
        polys = translate_polys(polys, -self.bbox[0])

        # sort quads to the back
        sizes = np.asarray([-len(p[0]) if len(p) == 1 else -1000*len(p[0]) for p in polys], dtype='int32')
        order = np.argsort(sizes)
        polys = [polys[o] for o in order]

        # ensure that first edge in each poly is south-facing and count all points
        self._points_count = 0
        for p in polys:
            for i in range(len(p)):
                r = p[i]
                self._points_count += len(r)
                roll_amount = -1
                for j in range(len(r)-1):
                    x1 = r[j,0]
                    x2 = r[j+1, 0]
                    if x2 > x1:
                        roll_amount = j
                        break
                if roll_amount != 0:
                    p[i] = np.roll(p[i], -roll_amount, 0)

        self._union_polys = polys
        return self._union_polys

    @property
    def points_count(self):
        _ = self.union_polys  # ensure up-to-date counts
        return self._points_count
    
    @property
    def triangles(self):
        if self._triangles is not None:
            return self._triangles

        self._triangles = [triangulate(p) for p in self.union_polys]
        self._triangles_points_count = 0
        for t in self._triangles:
            self._triangles_points_count += len(t)

        return self._triangles
    
    @property
    def triangles_points_count(self):
        _ = self.triangles  # ensure up-to-date counts
        return self._triangles_points_count
    
    @property
    def edge_counts(self):
        cnts = [0, 0, 0, 0]
        for poly in self.union_polys:
            for ring in poly:
                for nrm in edge_normals(ring):
                    if nrm[0] == 0 and nrm[1] < 0:
                        cnts[0] += 1
                    elif nrm[1] == 0 and nrm[0] > 0:
                        cnts[1] += 1
                    elif nrm[0] == 0 and nrm[1] > 0:
                        cnts[2] += 1
                    else:
                        cnts[3] += 1
        return cnts

    @property
    def points_str(self):
        points = []
        x_acc = 0
        y_acc = 0
        for i, p in enumerate(self.union_polys):
            for r in p:
                points.append(len(r))
                dx = r[0,0] - x_acc
                points.append(dx)
                x_acc += dx
                dy = r[0,1] - y_acc
                points.append(dy)
                y_acc += dy
                for i in range(1, len(r)):
                    if (i & 1):
                        dx = r[i,0] - x_acc
                        points.append(dx)
                        x_acc += dx
                    else:
                        dy = r[i,1] - y_acc
                        points.append(dy)
                        y_acc += dy
        
        points = np.asarray(points, dtype='int32')

        return base64.b64encode(bvlq4s_encode(points)).decode('utf-8')


    @property
    def triangles_batched(self):
        all_tris = []
        offset = 0
        for poly, tris in zip(self.union_polys, self.triangles):
            points = sum([len(ring) for ring in poly])
            all_tris.append(tris + offset)
            offset += points
        if len(all_tris) > 0:
            all_tris = np.hstack(all_tris)

        return all_tris

    @property
    def triangles_str(self):
        all_tris = np.asarray(self.triangles_batched, dtype='int32')
        acc = 0
        for i in range(len(all_tris)):
            d = all_tris[i] - acc
            all_tris[i] = d
            acc += d

        return base64.b64encode(bvlq2s_encode(all_tris)).decode('utf-8')


layers = [
    Layer(name='p-substrate', layer_datatype=(235, 4),  elevation=0,         thickness=0,    color=(0/3, 0.7, 0.35)   ),
    Layer(name='n-well',      layer_datatype=(64, 20),  elevation=0,         thickness=0,    color=(2/3, 0.7, 0.35)   ),
    Layer(name='diff (opp.)', layer_datatype=(65, 20),  elevation=0,         thickness=0,    color=(2/3, 0.0, 0.15)   ),
    Layer(name='tap (same)',  layer_datatype=(65, 44),  elevation=0,         thickness=0,    color=(2/3, 0.0, 0.15)   ),
    Layer(name='poly',        layer_datatype=(66, 20),  elevation=500,       thickness=400,  color=(1.5/3, 0.55, 0.25)),
    Layer(name='nwell.pin',   layer_datatype=(64, 16),  elevation=940,       thickness=940,  color=(0.4/3, 0.65, 0.3) ),
    Layer(name='pwell.pin',   layer_datatype=(122, 16), elevation=940,       thickness=940,  color=(0.4/3, 0.65, 0.3) ),
    Layer(name='licon',       layer_datatype=(66, 44),  elevation=940,       thickness=940,  color=(0.4/3, 0.65, 0.3) ),
    Layer(name='li',          layer_datatype=(67, 20),  elevation=1011,      thickness=100,  color=(0.4/3, 0.65, 0.3) ),
    Layer(name='mcon',        layer_datatype=(67, 44),  elevation=1380,      thickness=380,  color=(1/3, 0.8, 0.45)   ),
    Layer(name='m1',          layer_datatype=(68, 20),  elevation=1380+360,  thickness=360,  color=(1/3, 0.8, 0.45)   ),
    Layer(name='via',         layer_datatype=(68, 44),  elevation=2000,      thickness=270,  color=(1/3, 0.8, 0.6)    ),
    Layer(name='m2',          layer_datatype=(69, 20),  elevation=2000+360,  thickness=360,  color=(1/3, 0.8, 0.6)    ),
    Layer(name='via2',        layer_datatype=(69, 44),  elevation=2790,      thickness=420,  color=(1/3, 0.8, 0.7)    ),
    Layer(name='m3',          layer_datatype=(70, 20),  elevation=2790+850,  thickness=850,  color=(1/3, 0.8, 0.7)    ),
    Layer(name='via3',        layer_datatype=(70, 44),  elevation=4020,      thickness=390,  color=(1/3, 0.8, 0.8)    ),
    Layer(name='m4',          layer_datatype=(71, 20),  elevation=4020+850,  thickness=850,  color=(1/3, 0.8, 0.8)    ),
    Layer(name='via4',        layer_datatype=(71, 44),  elevation=5370,      thickness=510,  color=(1/3, 0.8, 0.9)    ),
    Layer(name='m5',          layer_datatype=(72, 20),  elevation=5370+1260, thickness=1260, color=(1/3, 0.8, 0.9)    )
]


def write_data(f):
    f.write("const data = [\n")
    for l in layers:
        f.write(f"{{ layer: '{l.layer_datatype[0]}/{l.layer_datatype[1]}',\n")
        f.write(f"  elevation: {l.elevation},\n")
        f.write(f"  thickness: {l.thickness},\n")
        f.write(f"  color: {list(colorsys.hsv_to_rgb(*l.color)) + [1.0]},\n")
        f.write(f"  xy_range: {l.xy_range},\n")
        f.write(f"  xy_nm_per_unit: 1.0,\n")
        f.write(f"  points_count: {l.points_count},\n")
        f.write(f"  points_str: '{l.points_str}',\n")
        f.write(f"  triangles_points_count: {l.triangles_points_count},\n")
        f.write(f"  triangles_str: '{l.triangles_str}',\n")
        f.write(f"  edge_counts: {l.edge_counts},\n")
        f.write(f"}},\n")
    f.write("];\n")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Translate GDSII to WebGL for visualization.')
    parser.add_argument('-i', '--input', required=True, help='Input GDSII file.')
    parser.add_argument('-o', '--output', required=True, help='Output file. "<file>.html" outputs a self-contained webpage, "<file>.js" outputs 3D data as Javascript.')
    args = parser.parse_args()
    if args.output.endswith('.html'):
        print(f'Reading index.html')
        with open('index.html', 'r') as f:
            index_html = f.readlines()
        print(f'Reading bundle.js')
        with open('bundle.js', 'r') as f:
            bundle_js = f.readlines()
    print(f'Loading {args.input}')
    gdslib = gdspy.GdsLibrary(infile=args.input)
    topcell = gdslib.top_level()[0]
    print(f'Top {topcell.name}')

    for l in layers:
        l.add_gds_polys(gdslib)

    bbox = topcell.get_bounding_box()
    origin_um = bbox[0]*gdslib.unit*1e6
    max_um = bbox[1]*gdslib.unit*1e6
    size_um = max_um-origin_um
    print(f'PhysicalSize {size_um[0]:.3f} x {size_um[1]:.3f} µm')
    scale = 1.0/max(size_um)
    print(f'ScalingFactor {scale:.3e}')
    print(f'ModelSize {size_um[0]*scale:.3f} x {size_um[1]*scale:.3f}')
    
    with open(args.output, 'w') as f:
        if args.output.endswith('.html'):
            for l in index_html:
                l = l.replace('</title>', f' - {args.input}</title>')
                if '<script src="data.js"></script>' in l:
                    f.write('<script>\n')
                    write_data(f)
                    f.write('</script>\n')
                elif '<script src="bundle.js"></script>' in l:
                    f.write('<script>\n')
                    for ll in bundle_js:
                        f.write(ll)
                    f.write('</script>\n')
                else:
                    f.write(l)
        else:
            write_data(f)

